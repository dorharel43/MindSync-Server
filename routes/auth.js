const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth, forgetUser, setTokenVersion } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');

// ---- Abuse limits (30/9 security pass) ----------------------------------
// Numbers can be changed on Render without code. A whole class signing up
// from the campus Wi-Fi shares one address, so per-address limits are
// generous; the per-EMAIL limit is what stops password guessing.
const n = (v, d) => Number(v) || d;
const REG_PER_IP_HOUR = n(process.env.REGISTER_PER_IP_HOUR, 12);
const REG_PER_DAY = n(process.env.REGISTER_PER_DAY, 300);
const LOGIN_PER_IP_15M = n(process.env.LOGIN_PER_IP_15MIN, 60);
const LOGIN_FAILS_PER_EMAIL_15M = 8;
const DELETE_FAILS_15M = 5;
const MIN15 = 15 * 60 * 1000;

const registerLimit = limits.rateLimit({
    name: 'register-ip', windowMs: 60 * 60 * 1000, max: REG_PER_IP_HOUR, key: limits.byIp,
    message: 'Too many new accounts from this network. Try again in an hour.'
});
const registerDaily = limits.rateLimit({
    name: 'register-all', windowMs: 24 * 60 * 60 * 1000, max: REG_PER_DAY, key: () => 'all',
    message: 'Sign-ups are paused for today. Please try again tomorrow.'
});
const loginLimit = limits.rateLimit({
    name: 'login-ip', windowMs: MIN15, max: LOGIN_PER_IP_15M, key: limits.byIp,
    message: 'Too many login attempts. Try again in a few minutes.'
});

// Strings only - an object or array here used to reach bcrypt and fail
// with an internal error.
function readCredentials(body) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    return { email, password };
}
// bcrypt only uses the first 72 bytes, so longer would silently not count.
const MAX_PASSWORD_BYTES = 72;

// Compared against when the email doesn't exist, so a wrong email takes as
// long as a wrong password - the timing doesn't reveal who has an account.
let dummyHash = null;
async function dummyCheck(password) {
    const bcrypt = require('bcrypt');
    if (!dummyHash) dummyHash = await bcrypt.hash('not-a-real-password', 12);
    await bcrypt.compare(password || 'x', dummyHash);
}

const TOKEN_TTL = '30d'; // desktop app, not a browser session - long-lived on purpose

function issueToken(user) {
    // tv: the account's token version - see models/User.js tokenVersion.
    return jwt.sign({ sub: user._id.toString(), tv: user.tokenVersion || 0 }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Shared shape returned after register/login and by /me, so the client
// doesn't have to know three slightly different response formats.
function publicUser(user) {
    return { id: user._id, email: user.email, name: user.name, degree: user.degree, guideDone: !!user.guideDone };
}

// POST /api/auth/register   { email, password, name?, degree? }
router.post(
    '/register',
    registerLimit, registerDaily,
    asyncHandler(async (req, res) => {
        const { email, password } = readCredentials(req.body);
        const name = typeof req.body.name === 'string' ? req.body.name : undefined;
        const degree = typeof req.body.degree === 'string' ? req.body.degree : undefined;

        if (!email || !password) {
            throw new ApiError(400, 'Email and password are required.');
        }
        if (password.length < 8) {
            throw new ApiError(400, 'Password must be at least 8 characters.');
        }
        if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
            throw new ApiError(400, 'Password is too long (72 characters at most).');
        }

        const existing = await User.findOne({ email });
        if (existing) {
            // Deliberately vague about WHICH field is wrong on login (below),
            // but registration is the one place it's fine - and necessary -
            // to say the email is taken, since the person needs to know to
            // log in instead.
            throw new ApiError(409, 'An account with that email already exists.');
        }

        const user = new User({ email, name, degree });
        await user.setPassword(password);
        await user.save();

        res.status(201).json({ token: issueToken(user), user: publicUser(user) });
    })
);

// POST /api/auth/login   { email, password }
router.post(
    '/login',
    loginLimit,
    asyncHandler(async (req, res) => {
        const { email, password } = readCredentials(req.body);
        if (!email || !password) {
            throw new ApiError(400, 'Email and password are required.');
        }
        // Password guessing: a few wrong tries per email FROM ONE ADDRESS,
        // then a pause - so someone guessing can't lock the real student
        // out from their own device. A looser limit per email from
        // anywhere stops guessing spread over many addresses.
        const failKey = `${email}|${limits.byIp(req)}`;
        let blocked = limits.peek('login-fail', failKey, LOGIN_FAILS_PER_EMAIL_15M);
        if (blocked.ok) blocked = limits.peek('login-fail-any', email, 60);
        if (!blocked.ok) {
            res.set('Retry-After', String(blocked.retryAfterSec));
            throw new ApiError(429, `Too many wrong passwords for this email. Try again in ${limits.waitText(blocked.retryAfterSec)}.`);
        }

        // .select('+passwordHash'): the schema hides this field by default
        // (see User.js), so it has to be asked for explicitly right here,
        // in the one place that legitimately needs it.
        const user = await User.findOne({ email }).select('+passwordHash');

        // Same error message whether the email doesn't exist or the password
        // is wrong. Distinguishing them tells an attacker which emails are
        // registered - a real cost for a guess that helps nobody legitimate.
        const INVALID = 'Invalid email or password.';
        const ok = user ? await user.checkPassword(password) : (await dummyCheck(password), false);
        if (!ok) {
            limits.hit('login-fail', failKey, MIN15, LOGIN_FAILS_PER_EMAIL_15M);
            limits.hit('login-fail-any', email, MIN15, 60);
            throw new ApiError(401, INVALID);
        }
        limits.reset('login-fail', failKey);

        res.json({ token: issueToken(user), user: publicUser(user) });
    })
);

// GET /api/auth/me - restores the session on app startup from a saved token,
// and doubles as the new home for what getProfile()/updateProfile() used to
// do against the old singleton Profile document.
router.get(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
        const user = await User.findById(req.userId);
        if (!user) throw new ApiError(404, 'User not found.');
        res.json(publicUser(user));
    })
);

// PUT /api/auth/me   { name?, degree?, guideDone? }
router.put(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { name, degree } = req.body;
        // Only ever a real boolean - anything else is ignored.
        const guideDone = typeof req.body.guideDone === 'boolean' ? req.body.guideDone : undefined;
        // Load + save rather than findByIdAndUpdate: same validation, and no
        // projection of the hidden passwordHash in the update (which some
        // Mongo-compatible databases can't do).
        const user = await User.findById(req.userId);
        if (!user) throw new ApiError(404, 'User not found.');
        Object.entries({ name, degree, guideDone }).forEach(([k, v]) => { if (v !== undefined) user[k] = v; });
        await user.save();
        res.json(publicUser(user));
    })
);

// POST /api/auth/change-password   { currentPassword, newPassword }  (30/9)
// Changing it logs out every OTHER device: the token version goes up, so
// older tokens stop working. This device gets a fresh token back.
router.post(
    '/change-password',
    requireAuth,
    asyncHandler(async (req, res) => {
        const current = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
        const next = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
        if (!current || !next) throw new ApiError(400, 'Enter your current password and a new one.');
        if (next.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');
        if (Buffer.byteLength(next, 'utf8') > MAX_PASSWORD_BYTES) throw new ApiError(400, 'Password is too long (72 characters at most).');
        const tries = limits.peek('password-fail', String(req.userId), DELETE_FAILS_15M);
        if (!tries.ok) throw new ApiError(429, `Too many wrong passwords. Try again in ${limits.waitText(tries.retryAfterSec)}.`);
        const user = await User.findById(req.userId).select('+passwordHash');
        if (!user) throw new ApiError(404, 'User not found.');
        if (!(await user.checkPassword(current))) {
            limits.hit('password-fail', String(req.userId), MIN15, DELETE_FAILS_15M);
            throw new ApiError(403, 'That password is not right.');
        }
        await user.setPassword(next);
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        await user.save();
        setTokenVersion(user._id, user.tokenVersion);
        res.json({ token: issueToken(user), user: publicUser(user) });
    })
);

// DELETE /api/auth/me   { password }
// Deletes the account and EVERYTHING that belongs to it: tasks, calendar
// items, folders, files (and their stored copies), questions, AI usage,
// feedback, and the Google Calendar connection (access revoked at Google).
// The password is asked again so a session left open, or a stolen token,
// can't delete an account.
// Order: user data first, the User last - if something fails half way the
// account still exists and the person can simply try again.
router.delete(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
        const password = typeof (req.body || {}).password === 'string' ? req.body.password : '';
        if (!password) throw new ApiError(400, 'Enter your password to delete your account.');
        // A stolen token must not be a way to guess the password.
        const tries = limits.peek('delete-fail', String(req.userId), DELETE_FAILS_15M);
        if (!tries.ok) throw new ApiError(429, `Too many wrong passwords. Try again in ${limits.waitText(tries.retryAfterSec)}.`);
        const user = await User.findById(req.userId).select('+passwordHash');
        if (!user) throw new ApiError(404, 'User not found.');
        // 403, not 401: a wrong password here doesn't end the session.
        if (!(await user.checkPassword(password))) {
            limits.hit('delete-fail', String(req.userId), MIN15, DELETE_FAILS_15M);
            throw new ApiError(403, 'That password is not right.');
        }

        const userId = user._id;
        // Google: revoke our access (best effort - Google being down must
        // not keep someone's account alive). The "MindSync" calendar in
        // their Google account is theirs; it stays.
        try { await require('../rpc/google').disconnect(userId); } catch (err) {
            console.warn('⚠️ Delete account: Google disconnect failed:', err.message);
        }
        await require('../rpc/storage').removeAllForUser(userId);
        const models = ['Task', 'Event', 'Folder', 'FileItem', 'StudyItem', 'AiUsage', 'Feedback', 'GoogleLink', 'Settings', 'ActiveDay'];
        const counts = {};
        for (const name of models) {
            const r = await require(`../models/${name}`).deleteMany({ userId });
            counts[name] = r.deletedCount || 0;
        }
        await User.deleteOne({ _id: userId });
        forgetUser(userId);
        console.log(`🗑️ Account deleted: ${userId} ${JSON.stringify(counts)}`);
        res.json({ deleted: true });
    })
);

module.exports = router;