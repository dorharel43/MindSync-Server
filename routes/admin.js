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
      require('../models/ExamRun').deleteMany({ userId: req.userId }),
      // The uploaded originals too (30/9).
      require('../rpc/storage').removeAllForUser(req.userId).catch(() => {}),
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

// Who is the owner (30/9):
//   ADMIN_USER_IDS - account ids (best: can't be claimed by anyone else)
//   ADMIN_EMAILS   - emails. Emails aren't verified, so ONLY list an email
//                    that is already registered - an unregistered one could
//                    be signed up by anybody. The owner's page shows its own
//                    account id, to move to ADMIN_USER_IDS.
const list = (v) => String(v || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
async function requireOwner(req, res, next) {
  try {
    const ids = list(process.env.ADMIN_USER_IDS);
    const emails = list(process.env.ADMIN_EMAILS);
    let ok = ids.includes(String(req.userId).toLowerCase());
    if (!ok && emails.length) {
      const me = await User.findById(req.userId).select('email').lean();
      ok = !!me && emails.includes(String(me.email).toLowerCase());
    }
    if (!ok) return res.status(404).json({ error: { message: 'Not found.', status: 404 } });
    next();
  } catch (err) { next(err); }
}

// "someone@example.com" -> "so***@example.com": enough to tell testers apart,
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
      StudyItem.find({}).select('userId reviews.reviewedAt reviews.outcome reviews.aiSuggested').lean(),
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
    // The AI check vs the student (30/9), last 30 days: answers the AI
    // checked, and how many the student marked differently - "stricter"
    // = the student gave themselves less than the AI did, "kinder" = more.
    // Many "stricter" = the check lets wrong answers through; many "kinder"
    // = the check is too harsh (or students are generous with themselves).
    const RANK = { got_it: 2, solved: 2, partial: 1, stuck: 1, missed: 0, wrong: 0 };
    const checkSince = daysAgo(29);
    const aiCheck = { checked: 0, agreed: 0, stricter: 0, kinder: 0 };
    items.forEach(it => {
      const p = u(it.userId);
      p.questions += 1;
      (it.reviews || []).forEach(r => {
        if (!r.reviewedAt) return;
        const d = dayOf(r.reviewedAt);
        p.answers += 1;
        if (d >= weekAgo) p.answersWeek += 1;
        if (d >= since) { p.days.add(d); reviewsPerDay[d] = (reviewsPerDay[d] || 0) + 1; }
        if (r.aiSuggested && d >= checkSince && r.aiSuggested in RANK && r.outcome in RANK) {
          aiCheck.checked += 1;
          const diff = RANK[r.outcome] - RANK[r.aiSuggested];
          if (diff === 0) aiCheck.agreed += 1; else if (diff < 0) aiCheck.stricter += 1; else aiCheck.kinder += 1;
        }
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
        id: String(user._id),
        isYou: String(user._id) === String(req.userId),
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
      you: String(req.userId),
      summary: {
        users: rows.length,
        newThisWeek: rows.filter(r => r.signedUp >= weekAgo).length,
        activeToday: rows.filter(r => r.lastActive === today).length,
        activeThisWeek: rows.filter(r => r.lastActive && r.lastActive >= weekAgo).length,
        cameBack: rows.filter(r => r.cameBack).length,
        answersThisWeek: rows.reduce((n, r) => n + r.answersWeek, 0),
        aiToday,
        aiCheck
      },
      daily,
      users: rows,
      feedback: feedback.map(f => ({ at: f.createdAt, from: nameOf.get(String(f.userId)) || '', page: f.page || '', text: f.text || '' }))
    });
  })
);

// POST /api/admin/delete-users   { ids: [...], confirm: 'DELETE' }  (30/9)
// The owner clears out test accounts made during the beta - each with all of
// its data, exactly like "Delete account" in Settings. Never the owner's own
// account (or another owner's). One at a time, so a failure half way leaves
// every account either fully there or fully gone.
router.post(
  '/delete-users',
  requireOwner,
  asyncHandler(async (req, res) => {
    if (req.body.confirm !== 'DELETE') return res.status(400).json({ error: { message: 'Type DELETE to confirm.', status: 400 } });
    const raw = Array.isArray(req.body.ids) ? req.body.ids : [];
    const ids = [...new Set(raw.filter(x => typeof x === 'string' && /^[a-f0-9]{24}$/i.test(x)))].slice(0, 500);
    if (!ids.length) return res.status(400).json({ error: { message: 'No accounts chosen.', status: 400 } });
    const owners = new Set([String(req.userId).toLowerCase(), ...list(process.env.ADMIN_USER_IDS)]);
    const emails = list(process.env.ADMIN_EMAILS);
    const { deleteAccount } = require('../utils/deleteAccount');
    const found = await User.find({ _id: { $in: ids } }).select('email').lean();
    let deleted = 0; const skipped = []; const failed = [];
    for (const u of found) {
      const id = String(u._id);
      if (owners.has(id.toLowerCase()) || emails.includes(String(u.email).toLowerCase())) { skipped.push(id); continue; }
      try { await deleteAccount(u._id, 'beta clean-up by the owner'); deleted += 1; } catch (err) {
        console.warn('admin delete failed:', id, err.message);
        failed.push(id);
      }
    }
    res.json({ deleted, skipped: skipped.length, failed: failed.length, notFound: ids.length - found.length });
  })
);

// ==========================================
// AI quality check (30/9) - owner only
// ==========================================
// "Is our model good enough?" answered with numbers, on the real server with
// the real key: answers whose right verdict is known go through the SAME
// check students get, and a short lecture goes through the SAME question
// writer. Pick a model to compare (one model only - no fallback, so the
// numbers belong to it). Costs ~35 short AI calls + 1 long one, not counted
// against anyone's allowance.
const { GRADE_CASES, SAMPLES } = require('../utils/aiQualityCases');

router.get(
  '/ai-models',
  requireOwner,
  asyncHandler(async (req, res) => {
    const ai = require('../rpc/aiProvider');
    const cfg = ai.readConfig();
    res.json({
      current: cfg.geminiKey ? ai.activeGeminiModel() : null,
      gemini: cfg.geminiKey ? [...new Set([ai.activeGeminiModel(), ai.DEFAULT_GEMINI_MODEL, ai.FALLBACK_GEMINI_MODEL, 'gemini-3.1-pro-preview'])] : [],
      openrouter: process.env.OPENROUTER_API_KEY ? ai.openRouterModels().map(m => `openrouter:${m}`) : []
    });
  })
);

const BUNDLED = /(ו(כיצד|איך|מה|מהי|מהו|איזה|איזו|למה|מדוע)\s)|(,[^,?]+ ו[\u05d0-\u05ea])|(\band (how|what|why|which)\b)/i;
const UNDERSTAND = /(למה|מדוע|מה ההבדל|מה יקרה|מה קורה|כיצד|איך|באיזה מקרה|מתי |מה המשמעות|השוו|הסבר|why|how does|what happens|difference|compare|when would|what does .* mean)/i;

// Runs in the background (review fix 30/9): ~35 AI calls can take longer
// than a hosting proxy lets one request live. POST starts it, GET polls it.
let aiCheckJob = null;   // { id, running, done, total, startedAt, result, error }

router.post(
  '/ai-check',
  requireOwner,
  asyncHandler(async (req, res) => {
    if (aiCheckJob && aiCheckJob.running) return res.status(409).json({ error: { message: 'A check is already running - wait for it.', status: 409 } });
    const m = typeof req.body.model === 'string' ? req.body.model.trim() : '';
    // A Gemini id ("gemini-3.8-flash") or "openrouter:<vendor>/<model>" - nothing else reaches a URL.
    const model = m && !m.includes('..') && /^(openrouter:[\w.-]+\/[\w.:-]+|[\w.-]{3,80})$/.test(m) ? m : null;
    if (m && !model) return res.status(400).json({ error: { message: 'That model name is not valid.', status: 400 } });
    const withGeneration = req.body.generation !== false;
    const ai = require('../rpc/aiProvider');
    const chosen = model || (ai.readConfig().geminiKey ? ai.activeGeminiModel() : null);
    aiCheckJob = { id: Date.now().toString(36), running: true, done: 0, total: GRADE_CASES.length + (withGeneration ? Object.keys(SAMPLES).length : 0), startedAt: new Date().toISOString(), result: null, error: null };
    const job = aiCheckJob;
    runAiCheck(chosen, withGeneration, job)
      .then(result => { job.result = result; })
      .catch(err => { job.error = String(err.message || err).slice(0, 300); console.error('AI check failed:', err.message); })
      .finally(() => { job.running = false; });
    res.status(202).json({ id: job.id, running: true, total: job.total });
  })
);

router.get(
  '/ai-check',
  requireOwner,
  asyncHandler(async (req, res) => {
    res.json(aiCheckJob || { running: false, result: null });
  })
);

async function runAiCheck(chosen, withGeneration, job) {
    const context = require('../rpc/context');
    const { handlers, makeEvent } = require('../rpc/electronShim');
    require('../rpc/handlers');
    const grade = handlers.get('grade-study-answer');
    const generate = handlers.get('generate-study-items');
    // No userId: nothing is counted against an allowance; one model only.
    const ctx = () => ({ token: '', userId: null, ip: null, events: new Set(), modelOverride: chosen });
    const started = Date.now();

    // ---- the check, 4 at a time
    const results = new Array(GRADE_CASES.length);
    let next = 0;
    const worker = async () => {
      while (next < GRADE_CASES.length) {
        const i = next++;
        const c = GRADE_CASES[i];
        const t0 = Date.now();
        let out;
        try {
          out = await context.run(ctx(), () => grade(makeEvent(), {
            question: c.q, expected: c.ref, userAnswer: c.a, mode: c.mode || 'recall', solutionSource: c.refByAi ? 'ai' : 'document'
          }));
        } catch (err) { out = { error: err.message }; }
        const got = out && out.verdict ? out.verdict : null;
        results[i] = {
          id: c.id, group: c.group || 'basics', kind: c.kind, expect: c.expect, got, sure: out ? out.sure : null,
          ok: got === c.expect, acceptable: got === c.expect || (c.accept || []).includes(got),
          feedback: out && out.feedback ? out.feedback : '', error: out && out.error ? String(out.error).slice(0, 200) : '',
          ms: Date.now() - t0, answer: c.a, question: c.q
        };
        job.done += 1;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);

    const answered = results.filter(r => r.got);
    const rank = { wrong: 0, partial: 1, correct: 2 };
    const summary = {
      cases: results.length,
      answered: answered.length,
      failed: results.length - answered.length,
      exact: answered.filter(r => r.ok).length,
      acceptable: answered.filter(r => r.acceptable).length,
      // The two ways to be wrong, which matter differently:
      tooLenient: answered.filter(r => !r.acceptable && rank[r.got] > rank[r.expect]).length,   // passes what it shouldn't -> readiness looks better than it is
      tooStrict: answered.filter(r => !r.acceptable && rank[r.got] < rank[r.expect]).length,    // fails a right answer -> students stop trusting it
      fooled: results.filter(r => r.kind === 'fooled by the answer' && r.got === 'correct').length,
      unsure: answered.filter(r => r.sure === false).length,
      medianMs: answered.length ? answered.map(r => r.ms).sort((a, b) => a - b)[Math.floor(answered.length / 2)] : null
    };
    // The same per subject (basics / calculus / java / csharp) - an average
    // can hide that one kind of material is graded badly.
    summary.groups = {};
    for (const r of results) {
      const g = summary.groups[r.group] = summary.groups[r.group] || { cases: 0, answered: 0, exact: 0, acceptable: 0, tooLenient: 0, tooStrict: 0 };
      g.cases += 1;
      if (!r.got) continue;
      g.answered += 1;
      if (r.ok) g.exact += 1;
      if (r.acceptable) g.acceptable += 1;
      else if (rank[r.got] > rank[r.expect]) g.tooLenient += 1;
      else g.tooStrict += 1;
    }

    // ---- the question writer: one lecture of each kind, side by side
    let generation = null;
    if (withGeneration && generate) {
      const words = (t) => String(t || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3);
      const hebrew = (t) => /[\u05d0-\u05ea]/.test(t);
      generation = {};
      await Promise.all(Object.entries(SAMPLES).map(async ([key, sample]) => {
        const t0 = Date.now();
        try {
          const raw = await context.run(ctx(), () => generate(makeEvent(), sample.text, { category: sample.course, sourceFile: '' }));
          const items = JSON.parse(raw);
          if (!Array.isArray(items)) throw new Error(items && items.error ? items.error : 'no items');
          const lecture = new Set(words(sample.text));
          const grounded = (it) => { const w = words(it.answer); return w.length ? w.filter(x => lecture.has(x)).length / w.length : 0; };
          generation[key] = {
            label: sample.label,
            ms: Date.now() - t0,
            count: items.length,
            understanding: items.filter(it => UNDERSTAND.test(it.question)).length,
            // Several ideas in one question ("define X, Y and Z", "what is A and how...").
            bundled: items.filter(it => BUNDLED.test(it.question) || (String(it.question).match(/\?/g) || []).length > 1).length,
            practice: items.filter(it => it.mode === 'practice').length,
            inHebrew: items.filter(it => hebrew(it.question)).length,
            latexLeft: items.filter(it => /\\(frac|sum|int|lambda|sigma|cdot|partial)|\$/.test(`${it.question} ${it.answer}`)).length,
            groundedAvg: items.length ? Math.round(100 * items.reduce((n, it) => n + grounded(it), 0) / items.length) : 0,
            items: items.slice(0, 40).map(it => ({ question: it.question, answer: String(it.answer || '').slice(0, 400), mode: it.mode, bundled: BUNDLED.test(it.question) || (String(it.question).match(/\?/g) || []).length > 1 }))
          };
        } catch (err) {
          generation[key] = { label: sample.label, error: String(err.message || err).slice(0, 300), ms: Date.now() - t0 };
        }
        job.done += 1;
      }));
    }
    return { model: chosen || 'default', ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000), summary, results, generation };
}

module.exports = router;