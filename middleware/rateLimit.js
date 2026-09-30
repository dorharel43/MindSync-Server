// Simple in-memory rate limits (30/9 security pass).
//
// One Render instance, so counters in memory are enough - no Redis. Each
// limiter counts hits per key (IP address, user id, or email) in a fixed
// time window and answers 429 with a plain message when the limit is passed.
//
//   rateLimit({ name, windowMs, max, key, message })
//     key(req) -> string | null   (null = not limited)
//
// Also exported: hit(name, key, windowMs, max) for counting inside a route
// (e.g. only FAILED logins), and reset(name, key) to forgive after success.
const ApiError = require('./ApiError');

const buckets = new Map();   // name -> Map(key -> { count, resetAt })

function bucket(name) {
    if (!buckets.has(name)) buckets.set(name, new Map());
    return buckets.get(name);
}

// Returns { ok, retryAfterSec }.
function hit(name, key, windowMs, max) {
    const b = bucket(name);
    const now = Date.now();
    let e = b.get(key);
    if (!e || e.resetAt <= now) {
        e = { count: 0, resetAt: now + windowMs };
        b.set(key, e);
    }
    e.count += 1;
    // Don't let a flood of unique keys grow memory without end.
    if (b.size > 50000) {
        for (const [k, v] of b) if (v.resetAt <= now) b.delete(k);
        if (b.size > 50000) b.clear();
    }
    return { ok: e.count <= max, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
}

function peek(name, key, max) {
    const e = bucket(name).get(key);
    if (!e || e.resetAt <= Date.now()) return { ok: true, retryAfterSec: 0 };
    return { ok: e.count < max, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - Date.now()) / 1000)) };
}

function reset(name, key) { bucket(name).delete(key); }

function waitText(sec) {
    return sec >= 120 ? `${Math.ceil(sec / 60)} minutes` : `${sec} seconds`;
}

function rateLimit({ name, windowMs, max, key, message }) {
    return (req, res, next) => {
        const k = key(req);
        if (k == null) return next();
        const r = hit(name, k, windowMs, max);
        if (r.ok) return next();
        res.set('Retry-After', String(r.retryAfterSec));
        next(new ApiError(429, message || `Too many requests. Try again in ${waitText(r.retryAfterSec)}.`));
    };
}

// The client's address. server.js sets 'trust proxy' so this is the real
// visitor behind Render's proxy, not the proxy itself.
const byIp = (req) => req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
const byUser = (req) => (req.userId ? String(req.userId) : byIp(req));

module.exports = { rateLimit, hit, peek, reset, waitText, byIp, byUser };
