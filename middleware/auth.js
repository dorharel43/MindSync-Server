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

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        req.userId = payload.sub;
        next();
    } catch (err) {
        const message = err.name === 'TokenExpiredError'
            ? 'Session expired. Please log in again.'
            : 'Invalid or tampered token.';
        next(new ApiError(401, message));
    }
}

module.exports = { requireAuth };