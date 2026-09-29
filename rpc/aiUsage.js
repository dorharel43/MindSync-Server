// Daily AI allowance per user (web version - the server's key pays).
//
// Checked BEFORE a call and counted only AFTER it succeeds, so a Google
// outage (503) doesn't eat anyone's allowance.
//   AI_DAILY_HEAVY  (default 15)  - whole-file jobs: questions, summaries, syllabus
//   AI_DAILY_LIGHT  (default 150) - short jobs: classifying, reading a date
const AiUsage = require('../models/AiUsage');
const { todayIso } = require('../utils/examSchedule');
const { currentContext } = require('./context');

const LIMITS = {
    heavy: Number(process.env.AI_DAILY_HEAVY) || 15,
    light: Number(process.env.AI_DAILY_LIGHT) || 150
};

class AiLimitError extends Error {
    constructor(kind) {
        super(kind === 'heavy'
            ? `You've used today's ${LIMITS.heavy} AI file actions (questions, summaries, syllabi). They reset at midnight.`
            : 'You\'ve used today\'s AI allowance. It resets at midnight.');
        this.name = 'AiLimitError';
        this.aiLimit = true;
    }
}

function currentUserId() {
    const ctx = currentContext();
    return ctx && ctx.userId ? ctx.userId : null;
}

async function check(kind) {
    const userId = currentUserId();
    if (!userId) return;                       // not inside a user request (tests, scripts)
    const doc = await AiUsage.findOne({ userId, day: todayIso() }).lean();
    if (doc && (doc[kind] || 0) >= LIMITS[kind]) throw new AiLimitError(kind);
}

async function count(kind) {
    const userId = currentUserId();
    if (!userId) return;
    await AiUsage.updateOne({ userId, day: todayIso() }, { $inc: { [kind]: 1 } }, { upsert: true });
}

async function today(userId) {
    const doc = await AiUsage.findOne({ userId, day: todayIso() }).lean();
    return { heavy: doc ? doc.heavy : 0, light: doc ? doc.light : 0, limits: LIMITS };
}

module.exports = { check, count, today, LIMITS, AiLimitError };
