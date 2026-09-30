// Daily AI allowance (web version - the server's key pays for every call).
//
// 30/9 security pass - it used to check before the call and count after it,
// so 10 requests sent at once all saw "0 used" and all reached Google. Now:
//   1. RESERVE before the call, atomically ($inc, then check) - a request
//      over the limit gives its reservation back and is refused;
//   2. at most AI_MAX_PARALLEL AI jobs per user at the same time;
//   3. a daily cap for ALL users together (AI_GLOBAL_DAILY_*) - accounts are
//      free, so the per-user limit alone doesn't bound what the key costs;
//   4. a failed call gives the reservation back only when Google didn't do
//      the work (busy / rate-limited / unreachable). Timeouts and blocked
//      answers still count - Google may have billed them.
//
//   AI_DAILY_HEAVY  (15)   whole-file jobs per user: questions, summaries, syllabi
//   AI_DAILY_LIGHT  (150)  short jobs per user: grading an answer, reading a date
//   AI_GLOBAL_DAILY_HEAVY (400) / AI_GLOBAL_DAILY_LIGHT (4000)  all users together
//   AI_MAX_PARALLEL (2)    AI jobs running at once per user
const AiUsage = require('../models/AiUsage');
const { todayIso } = require('../utils/examSchedule');
const { currentContext } = require('./context');

const num = (v, d) => Number(v) || d;
const LIMITS = {
    heavy: num(process.env.AI_DAILY_HEAVY, 15),
    light: num(process.env.AI_DAILY_LIGHT, 150)
};
const GLOBAL = {
    heavy: num(process.env.AI_GLOBAL_DAILY_HEAVY, 400),
    light: num(process.env.AI_GLOBAL_DAILY_LIGHT, 4000)
};
const MAX_PARALLEL = num(process.env.AI_MAX_PARALLEL, 2);

class AiLimitError extends Error {
    constructor(kind, why = 'user') {
        super(why === 'busy'
            ? 'Another AI job of yours is still running - wait for it to finish, then try again.'
            : why === 'global'
                ? 'The AI has reached today\'s limit for everyone. It resets at midnight.'
                : kind === 'heavy'
                    ? `You've used today's ${LIMITS.heavy} AI file actions (questions, summaries, syllabi). They reset at midnight.`
                    : 'You\'ve used today\'s AI allowance. It resets at midnight.');
        this.name = 'AiLimitError';
        this.aiLimit = true;
    }
}

function currentUserId() {
    const ctx = currentContext();
    return ctx && ctx.userId ? String(ctx.userId) : null;
}

// ---- all users together: kept in memory, loaded from the DB once a day ----
let globalDay = '';
let globalUsed = null;       // { heavy, light } or a Promise while loading
async function globalCounts(day) {
    if (globalDay === day && globalUsed && !globalUsed.then) return globalUsed;
    if (globalDay !== day || !globalUsed) {
        globalDay = day;
        globalUsed = AiUsage.find({ day }).select('heavy light').lean().then(docs => {
            const c = { heavy: 0, light: 0 };
            docs.forEach(d => { c.heavy += d.heavy || 0; c.light += d.light || 0; });
            globalUsed = c;
            return c;
        }).catch(() => { globalUsed = { heavy: 0, light: 0 }; return globalUsed; });
    }
    return globalUsed;
}

// ---- jobs running right now, per user ----
const running = new Map();   // userId -> count

async function incUser(userId, day, kind, by) {
    try {
        return await AiUsage.findOneAndUpdate({ userId, day }, { $inc: { [kind]: by } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
    } catch (err) {
        if (err && err.code === 11000) {   // two first-of-the-day upserts at once
            return AiUsage.findOneAndUpdate({ userId, day }, { $inc: { [kind]: by } }, { new: true }).lean();
        }
        throw err;
    }
}

// Returns a ticket for release(), or null outside a user request (tests,
// scripts, the desktop app - which uses the user's own key).
async function reserve(kind) {
    const userId = currentUserId();
    if (!userId) return null;
    if ((running.get(userId) || 0) >= MAX_PARALLEL) throw new AiLimitError(kind, 'busy');
    running.set(userId, (running.get(userId) || 0) + 1);   // before any await: no race
    const day = todayIso();
    try {
        const g = await globalCounts(day);
        if ((g[kind] || 0) >= GLOBAL[kind]) throw new AiLimitError(kind, 'global');
        g[kind] = (g[kind] || 0) + 1;
        const doc = await incUser(userId, day, kind, 1);
        if ((doc && doc[kind]) > LIMITS[kind]) {
            g[kind] -= 1;
            await incUser(userId, day, kind, -1).catch(() => {});
            throw new AiLimitError(kind);
        }
        return { userId, day, kind };
    } catch (err) {
        running.set(userId, Math.max(0, (running.get(userId) || 1) - 1));
        throw err;
    }
}

// done: the call finished. refund: give the reservation back (Google
// didn't do the work).
async function release(ticket, refund) {
    if (!ticket) return;
    running.set(ticket.userId, Math.max(0, (running.get(ticket.userId) || 1) - 1));
    if (!refund) return;
    if (globalDay === ticket.day && globalUsed && !globalUsed.then) globalUsed[ticket.kind] = Math.max(0, (globalUsed[ticket.kind] || 0) - 1);
    await incUser(ticket.userId, ticket.day, ticket.kind, -1).catch(err => console.warn('AI usage refund failed:', err.message));
}

// Google didn't do (or bill) the work: busy, rate-limited, unreachable.
function notBilled(err) {
    if (!err || err.aiLimit) return true;
    if (err.tooManyPages) return true;   // refused before anything was sent
    if (err.overloaded) return true;
    const status = Number(err.status || err.statusCode || 0);
    if (status === 429 || status === 503 || status === 502 || status === 500) return true;
    return /ECONNREFUSED|ENOTFOUND|fetch failed|Could not reach/i.test(String(err.message || ''));
}

async function today(userId) {
    const doc = await AiUsage.findOne({ userId, day: todayIso() }).lean();
    return { heavy: doc ? doc.heavy : 0, light: doc ? doc.light : 0, limits: LIMITS };
}

module.exports = { reserve, release, notBilled, today, LIMITS, GLOBAL, MAX_PARALLEL, AiLimitError };
