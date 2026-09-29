const jwt = require('jsonwebtoken');
const ApiError = require('./ApiError');

// Every data route (tasks, events, folders, files, study, stats...) needs
// this in front of it - that's the whole point of the change. It expects
// "Authorization: Bearer <token>" and, on success, sets req.userId so every
// route handler downstream can scope its query with { userId: req.userId }
// instead of returning the whole collection.
//
// Deliberately does NOT fetch the User document from the DB on every request
// - the token's payload (the user id) is enough for authorization here, and
// skipping that extra query keeps every single API call from paying for a
// database round-trip it doesn't need.
function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const [scheme, token] = header.split(' ');

    if (scheme !== 'Bearer' || !token) {
        return next(new ApiError(401, 'Missing or malformed Authorization header. Expected: Bearer <token>.'));
    }

    if (!process.env.JWT_SECRET) {
        // Fails loudly rather than silently trusting an unverifiable token -
        // a misconfigured server should refuse every request, not accept them.
        console.error('❌ JWT_SECRET is not set in the environment.');
        return next(new ApiError(500, 'Server auth is misconfigured.'));
    }

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
        const message = err.name === 'TokenExpiredError'
            ? 'Session expired. Please log in again.'
            : 'Invalid or tampered token.';
        return next(new ApiError(401, message));
    }
    // A valid token for an account that was deleted: refused. Tokens live 30
    // days, so without this an app left open elsewhere would keep writing
    // data for a user who no longer exists.
    userStillExists(payload.sub).then(ok => {
        if (!ok) return next(new ApiError(401, 'This account no longer exists.'));
        req.userId = payload.sub;
        markActive(payload.sub);
        next();
    }, next);
}

// "Used the app today" - one database write per user per day at most; the
// rest are answered from memory. Never holds up or fails a request.
const markedToday = new Set();
let markedDay = '';
function markActive(userId) {
    const { todayIso } = require('../utils/examSchedule');
    const day = todayIso();
    if (day !== markedDay) { markedToday.clear(); markedDay = day; }
    const key = String(userId);
    if (markedToday.has(key)) return;
    markedToday.add(key);
    require('../models/ActiveDay')
        .updateOne({ userId: key, day }, { $setOnInsert: { userId: key, day } }, { upsert: true })
        .catch(err => { markedToday.delete(key); console.warn('ActiveDay not saved:', err.message); });
}

// "Does this user exist?" asked on every request - so the answer is cached
// for a few minutes, and an account deleted on THIS server is forgotten at
// once (forgetUser). One Render instance, so an in-memory cache is enough.
const CHECK_TTL_MS = 5 * 60 * 1000;
const checkedAt = new Map();   // userId -> when it was last found
const deletedIds = new Set();
async function userStillExists(userId) {
    const id = String(userId || '');
    if (!id || deletedIds.has(id)) return false;
    const t = checkedAt.get(id);
    if (t && Date.now() - t < CHECK_TTL_MS) return true;
    let found = false;
    try {
        found = !!(await require('../models/User').exists({ _id: id }));
    } catch (err) {
        if (err.name === 'CastError') return false;   // not a valid id at all
        throw err;                                    // the database is down: a 500, not "logged out"
    }
    if (found) {
        if (checkedAt.size > 10000) checkedAt.clear();
        checkedAt.set(id, Date.now());
    }
    return found;
}
function forgetUser(userId) {
    checkedAt.delete(String(userId));
    deletedIds.add(String(userId));
}

module.exports = { requireAuth, forgetUser };