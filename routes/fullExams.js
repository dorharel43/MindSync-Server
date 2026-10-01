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
      check: ['checked', 'corrected'].includes(p.check) ? p.check : ''
    }))
  })).filter(q => q.parts.length);
  return {
    course: str(b.course, 100).trim(),
    title: str(b.title, 200),
    basis: b.basis === 'past_exams' ? 'past_exams' : 'material',
    pastExamFiles: (Array.isArray(b.pastExamFiles) ? b.pastExamFiles : []).slice(0, 10).map(f => str(f, 300)),
    durationMin: num(b.durationMin, 5, 600, 120),
    materials: str(b.materials, 400),
    instructions: str(b.instructions, 2000),
    totalPoints: num(b.totalPoints, 0, 5000, 100),
    questions,
    recurring: (Array.isArray(b.recurring) ? b.recurring : []).slice(0, 20).map(r => ({ topic: str(r.topic, 200), count: num(r.count, 0, 50), of: num(r.of, 0, 50), example: str(r.example, 600) })),
    language: str(b.language, 10)
  };
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
      const auto = part.type === 'mc' || (part.type === 'tf' && !part.reasonRequired);
      if (!row.choice.trim() && !row.text.trim()) row.status = 'blank';
      else if (auto) row.status = 'graded';   // marked here, whatever the app said
      if (row.status === 'graded') {
        if (auto) row.points = row.choice === String(part.correct) ? row.max : 0;
        else if (part.type === 'tf' && row.choice && row.choice !== String(part.correct)) row.points = 0;
        else row.points = num(a.points, 0, row.max);
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
    const exam = await FullExam.findOne({ _id: req.params.id, userId: req.userId }).select('course questions').lean();
    if (!exam) throw new ApiError(404, 'Exam not found');
    const b = req.body || {};
    const clientRunId = (typeof b.clientRunId === 'string' && b.clientRunId.slice(0, 40)) || require('crypto').randomBytes(12).toString('hex');
    const already = await FullExamRun.findOne({ userId: req.userId, clientRunId }).lean();
    if (already) return res.json({ ...already, id: String(already._id), duplicate: true });
    const answers = checkAnswers(exam, b.answers);
    // The score is added up here from the parts, not taken from the app.
    const counted = answers.filter(a => a.status === 'graded' || a.status === 'blank');
    const score = Math.round(counted.reduce((n, a) => n + Math.min(a.points, a.max), 0) * 10) / 10;
    const max = Math.round(counted.reduce((n, a) => n + a.max, 0) * 10) / 10;
    let run;
    try {
      run = await FullExamRun.create({
      userId: req.userId, examId: exam._id, course: exam.course,
      startedAt: b.startedAt ? new Date(b.startedAt) : new Date(), finishedAt: new Date(),
      limitSec: num(b.limitSec, 0, 36000), usedSec: num(b.usedSec, 0, 36000),
      answers, score, max, percent: max ? Math.round((score / max) * 100) : 0,
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
