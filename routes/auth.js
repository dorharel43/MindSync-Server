const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const User = require('../models/User');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

const TOKEN_TTL = '30d'; // desktop app, not a browser session - long-lived on purpose

function issueToken(user) {
    return jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, { expiresIn: TOKEN_TTL });
}

// Shared shape returned after register/login and by /me, so the client
// doesn't have to know three slightly different response formats.
function publicUser(user) {
    return { id: user._id, email: user.email, name: user.name, degree: user.degree };
}

// POST /api/auth/register   { email, password, name?, degree? }
router.post(
    '/register',
    asyncHandler(async (req, res) => {
        const { email, password, name, degree } = req.body;

        if (!email || !password) {
            throw new ApiError(400, 'Email and password are required.');
        }
        if (password.length < 8) {
            throw new ApiError(400, 'Password must be at least 8 characters.');
        }

        const existing = await User.findOne({ email: String(email).trim().toLowerCase() });
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
    asyncHandler(async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) {
            throw new ApiError(400, 'Email and password are required.');
        }

        // .select('+passwordHash'): the schema hides this field by default
        // (see User.js), so it has to be asked for explicitly right here,
        // in the one place that legitimately needs it.
        const user = await User.findOne({ email: String(email).trim().toLowerCase() }).select('+passwordHash');

        // Same error message whether the email doesn't exist or the password
        // is wrong. Distinguishing them tells an attacker which emails are
        // registered - a real cost for a guess that helps nobody legitimate.
        const INVALID = 'Invalid email or password.';
        if (!user) throw new ApiError(401, INVALID);

        const ok = await user.checkPassword(password);
        if (!ok) throw new ApiError(401, INVALID);

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

// PUT /api/auth/me   { name?, degree? }
router.put(
    '/me',
    requireAuth,
    asyncHandler(async (req, res) => {
        const { name, degree } = req.body;
        const user = await User.findByIdAndUpdate(
            req.userId,
            { name, degree },
            { new: true, runValidators: true, omitUndefined: true }
        );
        if (!user) throw new ApiError(404, 'User not found.');
        res.json(publicUser(user));
    })
);

module.exports = router;