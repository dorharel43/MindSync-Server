const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const Event = require('../models/Event');
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const StudyItem = require('../models/StudyItem');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(requireAuth);

// POST /api/admin/hard-reset - wipes the CALLER's data only.
// BUG FIX: this used to be Model.deleteMany({}) with no filter - a hard
// reset for one person would have wiped every user's tasks, events,
// folders and files. Also now includes StudyItem, which the original
// reset never touched despite the client calling this "reset all data".
router.post(
  '/hard-reset',
  asyncHandler(async (req, res) => {
    await Promise.all([
      Task.deleteMany({ userId: req.userId }),
      Event.deleteMany({ userId: req.userId }),
      Folder.deleteMany({ userId: req.userId }),
      FileItem.deleteMany({ userId: req.userId }),
      StudyItem.deleteMany({ userId: req.userId }),
    ]);
    res.json({ success: true });
  })
);

// ==========================================
// Owner's beta page (30/9): GET /api/admin/beta
// ==========================================
// Only for the emails in ADMIN_EMAILS (Render env, comma-separated). For
// anyone else - or when it isn't set - this route doesn't exist (404), so
// nobody learns there is something here to try.
const User = require('../models/User');
const ActiveDay = require('../models/ActiveDay');
const AiUsage = require('../models/AiUsage');
const Feedback = require('../models/Feedback');
const { todayIso } = require('../utils/examSchedule');

function adminEmails() {
  return String(process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}
async function requireOwner(req, res, next) {
  try {
    const allowed = adminEmails();
    const me = allowed.length ? await User.findById(req.userId).select('email').lean() : null;
    if (!me || !allowed.includes(String(me.email).toLowerCase())) {
      return res.status(404).json({ error: { message: 'Not found' } });
    }
    next();
  } catch (err) { next(err); }
}

// "dor.harel@gmail.com" -> "do***@gmail.com": enough to tell testers apart,
// without a list of full addresses on a screen.
function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '';
  return `${name.slice(0, 2)}***@${domain}`;
}
const dayOf = (date) => todayIso(new Date(date));
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return todayIso(d); };

router.get(
  '/beta',
  requireOwner,
  asyncHandler(async (req, res) => {
    const today = todayIso();
    const weekAgo = daysAgo(6);          // today + the 6 days before = 7 days
    const since = daysAgo(59);           // the page looks at 60 days at most

    const [users, activeRows, items, files, tasks, events, ai, feedback] = await Promise.all([
      User.find({}).select('name email createdAt').lean(),
      ActiveDay.find({ day: { $gte: since } }).lean(),
      StudyItem.find({}).select('userId reviews.reviewedAt').lean(),
      FileItem.find({}).select('userId').lean(),
      Task.find({}).select('userId').lean(),
      Event.find({}).select('userId').lean(),
      AiUsage.find({ day: { $gte: since } }).lean(),
      Feedback.find({}).sort({ createdAt: -1 }).limit(30).lean()
    ]);

    // Days each user was active: logged-in requests (ActiveDay) + days they
    // answered questions or used the AI (so days before ActiveDay existed
    // still count).
    const per = new Map();
    const u = (id) => {
      const k = String(id);
      if (!per.has(k)) per.set(k, { days: new Set(), questions: 0, answers: 0, answersWeek: 0, files: 0, tasks: 0, events: 0, aiWeek: 0 });
      return per.get(k);
    };
    activeRows.forEach(r => u(r.userId).days.add(r.day));
    const reviewsPerDay = {};
    items.forEach(it => {
      const p = u(it.userId);
      p.questions += 1;
      (it.reviews || []).forEach(r => {
        if (!r.reviewedAt) return;
        const d = dayOf(r.reviewedAt);
        p.answers += 1;
        if (d >= weekAgo) p.answersWeek += 1;
        if (d >= since) { p.days.add(d); reviewsPerDay[d] = (reviewsPerDay[d] || 0) + 1; }
      });
    });
    files.forEach(f => { u(f.userId).files += 1; });
    tasks.forEach(t => { u(t.userId).tasks += 1; });
    events.forEach(e => { u(e.userId).events += 1; });
    const aiToday = { heavy: 0, light: 0 };
    ai.forEach(a => {
      const p = u(a.userId);
      if (a.heavy || a.light) p.days.add(a.day);
      if (a.day >= weekAgo) p.aiWeek += (a.heavy || 0) + (a.light || 0);
      if (a.day === today) { aiToday.heavy += a.heavy || 0; aiToday.light += a.light || 0; }
    });

    const rows = users.map(user => {
      const p = u(user._id);
      const days = [...p.days].sort();
      const signup = dayOf(user.createdAt);
      return {
        name: user.name || '',
        email: maskEmail(user.email),
        signedUp: signup,
        lastActive: days[days.length - 1] || null,
        daysActive: days.length,
        // Came back = used it on a day other than the day they signed up.
        cameBack: days.some(d => d !== signup),
        questions: p.questions, answers: p.answers, answersWeek: p.answersWeek,
        files: p.files, tasks: p.tasks, events: p.events, aiWeek: p.aiWeek
      };
    }).sort((a, b) => String(b.lastActive || '').localeCompare(String(a.lastActive || '')) || b.signedUp.localeCompare(a.signedUp));

    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const d = daysAgo(i);
      let active = 0;
      per.forEach(p => { if (p.days.has(d)) active += 1; });
      daily.push({ day: d, active, answers: reviewsPerDay[d] || 0 });
    }

    const nameOf = new Map(users.map(x => [String(x._id), x.name || maskEmail(x.email)]));
    res.json({
      today,
      summary: {
        users: rows.length,
        newThisWeek: rows.filter(r => r.signedUp >= weekAgo).length,
        activeToday: rows.filter(r => r.lastActive === today).length,
        activeThisWeek: rows.filter(r => r.lastActive && r.lastActive >= weekAgo).length,
        cameBack: rows.filter(r => r.cameBack).length,
        answersThisWeek: rows.reduce((n, r) => n + r.answersWeek, 0),
        aiToday
      },
      daily,
      users: rows,
      feedback: feedback.map(f => ({ at: f.createdAt, from: nameOf.get(String(f.userId)) || '', page: f.page || '', text: f.text || '' }))
    });
  })
);

module.exports = router;