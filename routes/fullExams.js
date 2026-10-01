// Full exams (1/10) - see models/FullExam.js. The app writes the exam (AI)
// and grades it (AI); this stores the paper and the sittings, per user.
const express = require('express');
const router = express.Router();
const FullExam = require('../models/FullExam');
const FullExamRun = require('../models/FullExamRun');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

const KEEP_PER_COURSE = 20;
const KEEP_PER_USER = 200;
const RUNS_PER_EXAM = 20;
const isId = (v) => typeof v === 'string' && /^[a-f0-9]{24}$/i.test(v);
const str = (v, max) => String(v == null ? '' : v).slice(0, max);
const num = (v, lo, hi, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

// The app's JSON, trimmed to what the model holds - nothing else is kept.
function cleanExam(b) {
  const questions = (Array.isArray(b.questions) ? b.questions : []).slice(0, 30).map((q, qi) => ({
    n: num(q.n, 1, 60, qi + 1),
    title: str(q.title, 200),
    stem: str(q.stem, 8000),
    points: num(q.points, 0, 1000),
    choosePartsCount: Math.floor(num(q.choosePartsCount, 0, 50)),
    bonus: q.bonus === true,
    parts: (Array.isArray(q.parts) ? q.parts : []).slice(0, 60).map(p => ({
      label: str(p.label, 20),
      type: ['mc', 'tf', 'open', 'code'].includes(p.type) ? p.type : 'open',
      text: str(p.text, 6000),
      options: (Array.isArray(p.options) ? p.options : []).slice(0, 8).map(o => str(o, 1000)),
      correct: str(p.correct, 20),
      reasonRequired: p.reasonRequired === true,
      points: num(p.points, 0, 100),
      answer: str(p.answer, 12000),
      rubric: (Array.isArray(p.rubric) ? p.rubric : []).slice(0, 12).map(r => ({ criterion: str(r.criterion, 400), points: num(r.points, 0, 100) })),
      topic: str(p.topic, 120),
      check: ['checked', 'corrected', 'doubtful'].includes(p.check) ? p.check : ''
    }))
  })).filter(q => q.parts.length);
  // The totals are added up here: the regular questions, the bonus on top; a
  // capped top grade only below the total.
  if (!questions.some(q => !q.bonus)) questions.forEach(q => { q.bonus = false; });
  const sum = (qs) => Math.round(qs.reduce((n, q) => n + q.points, 0) * 100) / 100;
  const totalPoints = Math.min(5000, sum(questions.filter(q => !q.bonus)));
  const maxGrade = num(b.maxGrade, 0, 5000);
  return {
    course: str(b.course, 100).trim(),
    title: str(b.title, 200),
    basis: b.basis === 'past_exams' ? 'past_exams' : 'material',
    pastExamFiles: (Array.isArray(b.pastExamFiles) ? b.pastExamFiles : []).slice(0, 10).map(f => str(f, 300)),
    durationMin: num(b.durationMin, 5, 600, 120),
    materials: str(b.materials, 400),
    instructions: str(b.instructions, 2000),
    totalPoints,
    bonusPoints: Math.min(5000, sum(questions.filter(q => q.bonus))),
    maxGrade: maxGrade > 0 && maxGrade < totalPoints && maxGrade >= totalPoints * 0.75 ? maxGrade : 0,
    dontKnowShare: num(b.dontKnowShare, 0, 0.5),
    questions,
    recurring: (Array.isArray(b.recurring) ? b.recurring : []).slice(0, 20).map(r => ({ topic: str(r.topic, 200), count: num(r.count, 0, 50), of: num(r.of, 0, 50), example: str(r.example, 600) })),
    language: str(b.language, 10)
  };
}

// A sitting's total: bonus points add to the score, never to what it is out
// of. A capped top grade ("108 points, at most 100") is what the regular
// points are out of; parts the AI couldn't check are left out of both, in
// proportion.
function scoreAnswers(exam, answers) {
  const counted = answers.filter(a => a.status === 'graded' || a.status === 'blank');
  const isBonus = (a) => !!(exam.questions[a.q] && exam.questions[a.q].bonus);
  const add = (rows, f) => rows.reduce((n, a) => n + f(a), 0);
  const score = Math.round(add(counted, a => Math.min(a.points, a.max)) * 10) / 10;
  const regularAll = add(answers.filter(a => !isBonus(a)), a => a.max);
  const regularCounted = add(counted.filter(a => !isBonus(a)), a => a.max);
  const max = Math.round(regularCounted * 10) / 10;
  const base = exam.maxGrade > 0 && exam.maxGrade < regularAll ? exam.maxGrade : regularAll;
  const outOf = regularAll ? Math.round((base * regularCounted / regularAll) * 10) / 10 : 0;
  return { score, max, outOf, percent: outOf ? Math.min(100, Math.round((score / outOf) * 100)) : 0 };
}

// A written answer's points as the app sent them, within the rules that can
// be checked here: a wrong true/false verdict or a wrong choice gets 0; a
// right choice with a required reason gets 30%-100% (30% with no reason).
function ruledPoints(part, row, sent) {
  const reasoned = part.type === 'mc' && part.reasonRequired;
  if ((part.type === 'tf' || reasoned) && row.choice && row.choice !== String(part.correct)) return 0;
  if (reasoned) {
    if (!row.choice) return 0;
    if (!row.text.trim()) return Math.round(row.max * 0.3 * 100) / 100;
    return num(sent, Math.round(row.max * 0.3 * 100) / 100, row.max);
  }
  return num(sent, 0, row.max);
}

// The graded parts as the app sent them, checked against the paper: only
// parts that exist, once each; out of the part's own points; multiple choice
// and true/false without a reason marked here; "answer N of M" counts at most
// N parts. (The AI's points for written answers can't be re-checked here.)
function checkAnswers(exam, raw) {
  const sent = new Map();
  for (const a of (Array.isArray(raw) ? raw : []).slice(0, 2000)) {
    const key = `${Number(a && a.q)}:${Number(a && a.p)}`;
    if (!sent.has(key)) sent.set(key, a);
  }
  const out = [];
  (exam.questions || []).forEach((q, qi) => {
    let chosen = 0;
    (q.parts || []).forEach((part, pi) => {
      const a = sent.get(`${qi}:${pi}`) || {};
      const row = {
        q: qi, p: pi, choice: str(a.choice, 20), text: str(a.text, 20000),
        points: 0, max: part.points || 0, feedback: str(a.feedback, 3000),
        status: ['graded', 'blank', 'unchecked', 'not_chosen'].includes(a.status) ? a.status : 'blank'
      };
      if (row.status === 'not_chosen' && q.choosePartsCount > 0) { row.max = 0; out.push(row); return; }
      if (row.status === 'not_chosen') row.status = 'blank';
      if (q.choosePartsCount > 0 && ++chosen > q.choosePartsCount) { row.status = 'not_chosen'; row.max = 0; out.push(row); return; }
      const auto = (part.type === 'mc' || part.type === 'tf') && !part.reasonRequired;
      // a choice with a required reason that is wrong, or has no reason, is marked here too
      const decided = part.type === 'mc' && part.reasonRequired && (row.choice !== String(part.correct) || !row.text.trim());
      // "I don't know": only where the exam gives points for it - marked here.
      row.dontKnow = a.dontKnow === true && exam.dontKnowShare > 0 && !auto && !q.bonus;   // never on a bonus
      if (row.dontKnow) row.status = 'graded';
      else if (!row.choice.trim() && !row.text.trim()) row.status = 'blank';
      else if (auto || decided) row.status = 'graded';   // marked here, whatever the app said
      if (row.status === 'graded') {
        if (row.dontKnow) row.points = Math.round(row.max * exam.dontKnowShare * 100) / 100;
        else if (auto) row.points = row.choice === String(part.correct) ? row.max : 0;
        else row.points = ruledPoints(part, row, a.points);
      }
      out.push(row);
    });
  });
  return out;
}

// POST /api/full-exams   - save an exam the app just wrote
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = cleanExam(req.body || {});
    if (!data.course) throw new ApiError(400, 'course is required');
    if (!data.questions.length) throw new ApiError(400, 'The exam has no questions.');
    const exam = await FullExam.create({ userId: req.userId, ...data });
    // Keep the newest few per course, and per user (and their sittings).
    const old = [
      ...await FullExam.find({ userId: req.userId, course: data.course }).sort({ createdAt: -1 }).skip(KEEP_PER_COURSE).select('_id').lean(),
      ...await FullExam.find({ userId: req.userId }).sort({ createdAt: -1 }).skip(KEEP_PER_USER).select('_id').lean()
    ];
    if (old.length) {
      const ids = old.map(o => o._id);
      await FullExam.deleteMany({ _id: { $in: ids }, userId: req.userId });
      await FullExamRun.deleteMany({ examId: { $in: ids }, userId: req.userId });
    }
    res.status(201).json(exam);
  })
);

// GET /api/full-exams?course=...   - a list, without the papers
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { userId: req.userId };
    if (req.query.course) filter.course = String(req.query.course);
    const exams = await FullExam.find(filter).sort({ createdAt: -1 }).limit(40)
      .select('course title basis durationMin totalPoints createdAt questions.n').lean();
    const runs = await FullExamRun.find({ userId: req.userId, examId: { $in: exams.map(e => e._id) } })
      .sort({ finishedAt: -1 }).select('examId percent finishedAt').lean();
    const last = new Map();
    for (const r of runs) if (!last.has(String(r.examId))) last.set(String(r.examId), r);
    res.json(exams.map(e => ({
      id: String(e._id), course: e.course, title: e.title, basis: e.basis, durationMin: e.durationMin,
      totalPoints: e.totalPoints, questions: (e.questions || []).length, createdAt: e.createdAt,
      lastRun: last.has(String(e._id)) ? { percent: last.get(String(e._id)).percent, finishedAt: last.get(String(e._id)).finishedAt } : null
    })));
  })
);

// GET /api/full-exams/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw new ApiError(404, 'Exam not found');
    const exam = await FullExam.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!exam) throw new ApiError(404, 'Exam not found');
    res.json({ ...exam, id: String(exam._id) });
  })
);

// DELETE /api/full-exams/:id   - the exam and its sittings
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw new ApiError(404, 'Exam not found');
    const exam = await FullExam.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!exam) throw new ApiError(404, 'Exam not found');
    await FullExamRun.deleteMany({ examId: exam._id, userId: req.userId });
    res.json({ success: true });
  })
);

// POST /api/full-exams/:id/runs   - a graded sitting (sent twice = saved once)
router.post(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw new ApiError(404, 'Exam not found');
    const exam = await FullExam.findOne({ _id: req.params.id, userId: req.userId }).select('course questions maxGrade dontKnowShare').lean();
    if (!exam) throw new ApiError(404, 'Exam not found');
    const b = req.body || {};
    const clientRunId = (typeof b.clientRunId === 'string' && b.clientRunId.slice(0, 40)) || require('crypto').randomBytes(12).toString('hex');
    const already = await FullExamRun.findOne({ userId: req.userId, clientRunId }).lean();
    if (already) return res.json({ ...already, id: String(already._id), duplicate: true });
    const answers = checkAnswers(exam, b.answers);
    // The score is added up here from the parts, not taken from the app.
    let run;
    try {
      run = await FullExamRun.create({
      userId: req.userId, examId: exam._id, course: exam.course,
      startedAt: b.startedAt ? new Date(b.startedAt) : new Date(), finishedAt: new Date(),
      limitSec: num(b.limitSec, 0, 36000), usedSec: num(b.usedSec, 0, 36000),
      answers, ...scoreAnswers(exam, answers),
      weakTopics: (Array.isArray(b.weakTopics) ? b.weakTopics : []).slice(0, 10).map(t => str(t, 120)),
      clientRunId
      });
    } catch (err) {
      // The same sitting saved by a second request at the same moment.
      if (err && err.code === 11000) {
        const same = await FullExamRun.findOne({ userId: req.userId, clientRunId }).lean();
        if (same) return res.json({ ...same, id: String(same._id), duplicate: true });
      }
      throw err;
    }
    // Keep the newest sittings of the exam.
    const oldRuns = await FullExamRun.find({ userId: req.userId, examId: exam._id }).sort({ finishedAt: -1 }).skip(RUNS_PER_EXAM).select('_id').lean();
    if (oldRuns.length) await FullExamRun.deleteMany({ _id: { $in: oldRuns.map(r => r._id) }, userId: req.userId });
    res.status(201).json({ ...run.toObject(), id: String(run._id) });
  })
);

// PATCH /api/full-exams/:id/check   - a late check of a saved exam: only
// parts still unchecked change, and nothing is deleted.
router.patch(
  '/:id/check',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw new ApiError(404, 'Exam not found');
    const exam = await FullExam.findOne({ _id: req.params.id, userId: req.userId });
    if (!exam) throw new ApiError(404, 'Exam not found');
    let changed = 0;
    for (const x of (Array.isArray(req.body && req.body.parts) ? req.body.parts : []).slice(0, 400)) {
      if (!x || typeof x !== 'object') continue;
      const q = exam.questions[Number(x.q)];
      const part = q && q.parts[Number(x.p)];
      const check = ['checked', 'corrected', 'doubtful'].includes(x.check) ? x.check : '';
      if (!part || part.check || !check) continue;
      if (check === 'corrected') {
        const answer = str(x.answer, 12000).trim();
        if (answer) part.answer = answer;
        const rubric = (Array.isArray(x.rubric) ? x.rubric : []).slice(0, 12)
          .map(r => ({ criterion: str(r && r.criterion, 400), points: num(r && r.points, 0, 100) })).filter(r => r.criterion && r.points > 0);
        const sum = rubric.reduce((n, r) => n + r.points, 0);
        if (sum) part.rubric = rubric.map(r => ({ ...r, points: Math.round((r.points * part.points / sum) * 100) / 100 }));
        const c = str(x.correct, 20).trim().toLowerCase();
        if (part.type === 'mc' && /^\d+$/.test(c) && Number(c) < part.options.length) part.correct = c;
        if (part.type === 'tf' && (c === 'true' || c === 'false')) part.correct = c;
      }
      part.check = check;
      changed += 1;
    }
    if (changed) { exam.markModified('questions'); await exam.save(); }
    res.json({ ...exam.toObject(), id: String(exam._id), changed });
  })
);

// POST /api/full-exams/:id/runs/:runId/regrade   - "check again": only the
// parts the AI couldn't grade before change; the total is added up again here.
router.post(
  '/:id/runs/:runId/regrade',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.runId)) throw new ApiError(404, 'Result not found');
    const exam = await FullExam.findOne({ _id: req.params.id, userId: req.userId }).select('questions maxGrade dontKnowShare').lean();
    const run = await FullExamRun.findOne({ _id: req.params.runId, examId: req.params.id, userId: req.userId });
    if (!exam || !run) throw new ApiError(404, 'Result not found');
    const sent = new Map();
    for (const a of (Array.isArray(req.body && req.body.answers) ? req.body.answers : []).slice(0, 2000)) {
      const key = `${Number(a && a.q)}:${Number(a && a.p)}`;
      if (!sent.has(key)) sent.set(key, a);
    }
    const answers = run.answers.map(r => {
      const row = r.toObject ? r.toObject() : { ...r };
      const a = sent.get(`${row.q}:${row.p}`);
      if (row.status !== 'unchecked' || !a || a.status !== 'graded') return row;
      // The same rules as saving a sitting.
      const part = exam.questions[row.q] && exam.questions[row.q].parts[row.p];
      return { ...row, status: 'graded', points: part ? ruledPoints(part, { ...row, text: String(row.text || '') }, a.points) : 0, feedback: str(a.feedback, 3000) };
    });
    run.answers = answers;
    Object.assign(run, scoreAnswers(exam, answers));
    if (Array.isArray(req.body.weakTopics)) run.weakTopics = req.body.weakTopics.slice(0, 10).map(t => str(t, 120));
    await run.save();
    res.json({ ...run.toObject(), id: String(run._id) });
  })
);

// GET /api/full-exams/:id/runs
router.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    if (!isId(req.params.id)) throw new ApiError(404, 'Exam not found');
    const runs = await FullExamRun.find({ userId: req.userId, examId: req.params.id }).sort({ finishedAt: -1 }).limit(20).lean();
    res.json(runs.map(r => ({ ...r, id: String(r._id) })));
  })
);

module.exports = router;
