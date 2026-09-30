const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth, setTokenVersion } = require('../middleware/auth');
const limits = require('../middleware/rateLimit');
const crypto = require('crypto');
const mailer = require('../utils/mailer');
const emails = require('../utils/emails');

// ---- Abuse limits (30/9 security pass) ----------------------------------
// Numbers can be changed on Render without code. A whole class signing up
// from the campus Wi-Fi shares one address, so per-address limits are
// generous; the per-EMAIL limit is what stops password guessing.
const n = (v, d) => Number(v) || d;
const REG_PER_IP_HOUR = n(process.env.REGISTER_PER_IP_HOUR, 60);   // a whole class on one campus Wi-Fi
const REG_PER_DAY = n(process.env.REGISTER_PER_DAY, 300);
const LOGIN_PER_IP_15M = n(process.env.LOGIN_PER_IP_15MIN, 200);
const LOGIN_FAILS_PER_EMAIL_15M = 8;
const DELETE_FAILS_15M = 5;
const MIN15 = 15 * 60 * 1000;

// Once per start-up: what the server sees as the visitor's address, so the
// per-address limits can be checked on Render (behind its proxy).
let ipLogged = false;
function logIpOnce(req) {
    if (ipLogged) return;
    ipLogged = true;
    console.log(`ℹ️ client address check: ip=${req.ip} ips=${JSON.stringify(req.ips)} xff=${req.headers['x-forwarded-for'] || ''}`);
}

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
// Throwaway-mailbox services (30/9): an account on one of these is almost
// always the tenth account of the same person, made to get more of the free
// AI. Not a complete list - the per-network AI limit is the real backstop.
const DISPOSABLE = new Set([
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la',
    '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmail.net', 'tempmailo.com', 'temp-mail.io',
    'yopmail.com', 'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email', 'dispostable.com',
    'maildrop.cc', 'mailnesia.com', 'mintemail.com', 'throwawaymail.com', 'fakeinbox.com', 'emailondeck.com',
    'moakt.com', 'tmail.ws', 'mohmal.com', 'mail.tm', 'burnermail.io', 'spamgourmet.com', 'mailcatch.com',
    'inboxkitten.com', 'mytemp.email', 'tempr.email', 'discard.email', 'emailfake.com', 'fakemail.net', 'luxusmail.org'
]);
const isDisposable = (email) => DISPOSABLE.has(String(email).split('@')[1] || '');

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
    return {
        id: user._id, email: user.email, name: user.name, degree: user.degree, guideDone: !!user.guideDone,
        emailVerified: !!user.emailVerified, lang: user.lang || 'en',
        // Whether this server can send email at all - the app offers
        // "Resend the confirmation email" only then.
        mailEnabled: mailer.mailEnabled()
    };
}

// ---- Email: confirm the address, reset the password (30/9) ----------------
// Both links carry a signed token with a `purpose`, so neither can ever be
// used as a login (requireAuth refuses any token with a purpose), and a
// verify link can't reset a password or the other way round.
const VERIFY_TTL = '3d';
const RESET_TTL = '1h';
const langOf = (v) => (v === 'he' ? 'he' : v === 'en' ? 'en' : null);
// Ties a reset link to the password it was made for: once the password
// changes (by this link or any other way) the link stops working, so each
// link works once.
const passwordStamp = (hash) => crypto.createHash('sha256').update(String(hash || '')).digest('hex').slice(0, 16);

function verifyLink(user) {
    const token = jwt.sign({ sub: user._id.toString(), purpose: 'verify-email', email: user.email, lang: user.lang || 'en' },
        process.env.JWT_SECRET, { expiresIn: VERIFY_TTL });
    return `${mailer.publicUrl()}/api/auth/verify-email?token=${encodeURIComponent(token)}`;
}

// Never holds up or fails the request that triggered it; a failure is
// logged (without the address) for the owner to see on Render.
function sendVerifyEmail(user) {
    if (!mailer.mailEnabled()) return Promise.resolve(false);
    const mail = emails.verifyEmail({ lang: user.lang || 'en', name: user.name, link: verifyLink(user) });
    return mailer.sendMail({ to: user.email, toName: user.name || undefined, ...mail })
        .then(() => true)
        .catch(err => { console.warn('✉️ confirmation email not sent:', err.message); return false; });
}

// POST /api/auth/register   { email, password, name?, degree? }
router.post(
    '/register',
    (req, res, next) => { logIpOnce(req); next(); }, registerLimit, registerDaily,
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

        if (isDisposable(email)) {
            throw new ApiError(400, 'Please sign up with your regular email address (not a temporary one).');
        }

        const existing = await User.findOne({ email });
        if (existing) {
            // Deliberately vague about WHICH field is wrong on login (below),
            // but registration is the one place it's fine - and necessary -
            // to say the email is taken, since the person needs to know to
            // log in instead.
            throw new ApiError(409, 'An account with that email already exists.');
        }

        const user = new User({ email, name, degree, lang: langOf(req.body.lang) || 'en' });
        await user.setPassword(password);
        await user.save({ validateModifiedOnly: true });

        // Welcome + confirm the address - in the background, the account
        // is ready either way.
        sendVerifyEmail(user);
        res.status(201).json({ token: issueToken(user), user: publicUser(user) });
    })
);

// POST /api/auth/login   { email, password }
router.post(
    '/login',
    (req, res, next) => { logIpOnce(req); next(); }, loginLimit,
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
        const lang = langOf(req.body.lang) || undefined;   // the app's language, for our emails
        // Load + save rather than findByIdAndUpdate: same validation, and no
        // projection of the hidden passwordHash in the update (which some
        // Mongo-compatible databases can't do).
        const user = await User.findById(req.userId);
        if (!user) throw new ApiError(404, 'User not found.');
        Object.entries({ name, degree, guideDone, lang }).forEach(([k, v]) => { if (v !== undefined) user[k] = v; });
        await user.save({ validateModifiedOnly: true });
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
        await user.save({ validateModifiedOnly: true });
        setTokenVersion(user._id, user.tokenVersion);
        res.json({ token: issueToken(user), user: publicUser(user) });
    })
);

// GET /api/auth/mail-status - can this server send email? (The reset page
// and the app ask before offering "Forgot password?" / "Resend".)
router.get('/mail-status', (req, res) => res.json({ enabled: mailer.mailEnabled() }));

const resendLimit = limits.rateLimit({
    name: 'verify-resend', windowMs: 60 * 60 * 1000, max: 3, key: limits.byUser,
    message: 'We already sent a few - check your inbox (and spam). You can ask again in an hour.'
});

// POST /api/auth/resend-verification - a new confirmation email.
router.post(
    '/resend-verification',
    requireAuth, resendLimit,
    asyncHandler(async (req, res) => {
        if (!mailer.mailEnabled()) throw new ApiError(503, 'Email isn\'t set up on this server yet.');
        const user = await User.findById(req.userId);
        if (!user) throw new ApiError(404, 'User not found.');
        if (user.emailVerified) return res.json({ alreadyVerified: true });
        const sent = await sendVerifyEmail(user);
        if (!sent) throw new ApiError(502, 'The email couldn\'t be sent right now. Please try again later.');
        res.json({ sent: true });
    })
);

// A tiny page for the link in the confirmation email (no script; the site's
// security policy allows none inline anyway).
function resultPage(res, status, lang, title, text, { email = '', openHref = '/app/' } = {}) {
    const he = lang === 'he';
    const esc = emails.esc;
    res.status(status).type('html').send(`<!DOCTYPE html><html lang="${he ? 'he' : 'en'}" dir="${he ? 'rtl' : 'ltr'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>MindSync</title><link rel="icon" href="/favicon.ico" sizes="any">
<style>body{margin:0;background:#f5f6f8;color:#1d2433;font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.c{max-width:440px;margin:12vh auto 0;background:#fff;border:1px solid #e4e6eb;border-radius:10px;padding:28px 26px}
h1{font-size:20px;margin:0 0 8px}p{margin:0 0 18px;color:#4b5563}p.e{margin:-4px 0 12px;font-weight:600;color:inherit;word-break:break-all}a{display:inline-block;background:#2f64d6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
@media (prefers-color-scheme:dark){body{background:#111318;color:#e8ebf2}.c{background:#1a1d24;border-color:#2a2e37}p{color:#a3aab8}a{background:#7aa2f7;color:#0f172a}}</style></head>
<body><div class="c"><h1>${esc(title)}</h1>${email ? `<p class="e"><bdi dir="ltr">${esc(email)}</bdi></p>` : ''}<p>${esc(text)}</p><a href="${esc(openHref)}">${he ? 'פתיחת MindSync' : 'Open MindSync'}</a></div></body></html>`);
}

// GET /api/auth/verify-email?token=...  (the link in the email)
// Opening it twice is fine; a link for an address the account no longer
// has (or a deleted account) does nothing.
router.get(
    '/verify-email',
    asyncHandler(async (req, res) => {
        let p = null;
        try { p = jwt.verify(String(req.query.token || ''), process.env.JWT_SECRET); } catch (e) { p = null; }
        const lang = langOf(p && p.lang) || (/^he\b/i.test(req.headers['accept-language'] || '') ? 'he' : 'en');
        const he = lang === 'he';
        if (!p || p.purpose !== 'verify-email' || typeof p.sub !== 'string') {
            return resultPage(res, 400, lang, he ? 'הקישור לא תקף' : 'This link doesn\'t work',
                he ? 'יכול להיות שעברו יותר מ-3 ימים. אפשר לבקש מייל חדש בהגדרות ← חשבון באפליקציה.'
                   : 'It may be more than 3 days old. You can ask for a new one in Settings > Account in the app.');
        }
        const user = await User.findById(p.sub);
        if (!user || user.email !== p.email) {
            return resultPage(res, 400, lang, he ? 'הקישור לא תקף' : 'This link doesn\'t work',
                he ? 'החשבון הזה כבר לא קיים.' : 'This account no longer exists.');
        }
        if (!user.emailVerified) {
            user.emailVerified = true;
            await user.save({ validateModifiedOnly: true });
            require('../rpc/aiUsage').forgetVerified(user._id);   // the full AI allowance right away
        }
        // "Open MindSync" carries which account was confirmed: the app says so
        // when this browser is logged in to a different one (30/9 - a phone
        // with the main account open showed that account instead).
        resultPage(res, 200, lang, he ? 'כתובת המייל אושרה' : 'Your email is confirmed',
            he ? 'תודה! מעכשיו אפשר לאפס את הסיסמה דרך המייל אם צריך.' : 'Thanks! You can now reset your password by email if you ever need to.',
            { email: user.email, openHref: `/app/#verified=${user._id}` });
    })
);

// POST /api/auth/forgot-password   { email, lang? }
// Always the same answer, whether or not the email has an account - so
// this can't be used to find out who uses MindSync. The email is sent in
// the background (a registered address doesn't answer slower either).
const forgotIpLimit = limits.rateLimit({
    name: 'forgot-ip', windowMs: MIN15, max: n(process.env.FORGOT_PER_IP_15MIN, 20), key: limits.byIp,
    message: 'Too many requests. Try again in a few minutes.'
});
router.post(
    '/forgot-password',
    forgotIpLimit,
    asyncHandler(async (req, res) => {
        if (!mailer.mailEnabled()) throw new ApiError(503, 'Password reset by email isn\'t available yet.');
        const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            throw new ApiError(400, 'Enter the email you signed up with.');
        }
        // At most 3 emails an hour to one address - nobody can flood a
        // mailbox through us. Silently: the answer stays the same.
        const perEmail = limits.hit('forgot-email', email, 60 * 60 * 1000, 3);
        if (perEmail.ok) {
            const lang = langOf(req.body.lang);
            User.findOne({ email }).select('+passwordHash').then(user => {
                if (!user) return;
                const token = jwt.sign({ sub: user._id.toString(), purpose: 'reset', tv: user.tokenVersion || 0, ps: passwordStamp(user.passwordHash) },
                    process.env.JWT_SECRET, { expiresIn: RESET_TTL });
                // In the part after '#': never sent to a server, so it can't
                // end up in a log or a Referer header.
                const link = `${mailer.publicUrl()}/reset-password#token=${encodeURIComponent(token)}`;
                const mail = emails.resetEmail({ lang: lang || user.lang || 'en', link });
                return mailer.sendMail({ to: user.email, ...mail });
            }).catch(err => console.warn('✉️ reset email not sent:', err.message));
        }
        res.json({ ok: true });
    })
);

// POST /api/auth/reset-password   { token, password }
const resetIpLimit = limits.rateLimit({
    name: 'reset-ip', windowMs: MIN15, max: 30, key: limits.byIp,
    message: 'Too many tries. Try again in a few minutes.'
});
router.post(
    '/reset-password',
    resetIpLimit,
    asyncHandler(async (req, res) => {
        const token = typeof req.body.token === 'string' ? req.body.token : '';
        const password = typeof req.body.password === 'string' ? req.body.password : '';
        if (password.length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');
        if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) throw new ApiError(400, 'Password is too long (72 characters at most).');
        const EXPIRED = 'This link has expired or was already used. Ask for a new one.';
        let p = null;
        try { p = jwt.verify(token, process.env.JWT_SECRET); } catch (e) { p = null; }
        if (!p || p.purpose !== 'reset' || typeof p.sub !== 'string') throw new ApiError(400, EXPIRED);
        const user = await User.findById(p.sub).select('+passwordHash');
        if (!user || (user.tokenVersion || 0) !== (p.tv || 0) || passwordStamp(user.passwordHash) !== p.ps) {
            throw new ApiError(400, EXPIRED);
        }
        await user.setPassword(password);
        // Every device that was logged in is logged out (a reset is often
        // "someone else may have my password").
        user.tokenVersion = (user.tokenVersion || 0) + 1;
        // The link came to this mailbox - that confirms the address too.
        user.emailVerified = true;
        await user.save({ validateModifiedOnly: true });
        setTokenVersion(user._id, user.tokenVersion);
        require('../rpc/aiUsage').forgetVerified(user._id);
        limits.reset('login-fail-any', user.email);
        res.json({ ok: true });
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

        await require('../utils/deleteAccount').deleteAccount(user._id, 'by the user');
        res.json({ deleted: true });
    })
);

module.exports = router;