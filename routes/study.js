const express = require('express');
const router = express.Router();
const StudyItem = require('../models/StudyItem');
const Event = require('../models/Event');
const FileItem = require('../models/FileItem');
const asyncHandler = require('../middleware/asyncHandler');
const { assertRoom } = require('../middleware/perUserCap');
const ApiError = require('../middleware/ApiError');
const { schedule, calibrationReport, OUTCOME_CORRECT } = require('../utils/scheduler');
const { APP_TIME_ZONE, todayIso, nextExamByCourse, buildStudyQueue } = require('../utils/examSchedule');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// The user's upcoming exams (Planner events of type 'exam' with a date), and
// which course each belongs to - see utils/examSchedule.js. An exam lookup
// failing must never block studying, so it falls back to "no exams".
async function examsForCourses(userId, courses) {
  try {
    const today = todayIso();
    const exams = await Event.find({ userId, type: 'exam', date: { $gte: today } }).select('title date').lean();
    return nextExamByCourse(courses, exams, today);
  } catch (err) {
    console.warn('study: exam lookup failed, scheduling without exams:', err.message);
    return {};
  }
}

const courseOf = (item) => (item.category || '').trim() || 'Uncategorized';

// Is the gap closing?
//
// The calibration panel says how often "I'm sure" is actually right. It never
// said whether that is getting better, which after a fortnight of use is the
// only number that matters: the product's whole claim is that seeing the gap
// closes it.
//
// Split chronologically down the middle rather than by calendar window: a
// student who studied hard last week and not at all this week would otherwise
// be told their judgement collapsed, when really they just stopped answering.
//
// Generalised to any confidence level, not just 'sure' - "is your gut sense
// in the ambiguous middle (think_so) getting more trustworthy?" is the same
// question, just asked of a different bucket.
function confidenceTrend(reviews, confidenceLevel) {
  const MIN_PER_HALF = 5;
  const filtered = reviews
    .filter(r => r.confidence === confidenceLevel)
    .sort((a, b) => new Date(a.reviewedAt) - new Date(b.reviewedAt));

  if (filtered.length < MIN_PER_HALF * 2) return null;

  const half = Math.floor(filtered.length / 2);
  const pct = list => Math.round((list.filter(r => r.wasCorrect).length / list.length) * 100);
  const earlier = filtered.slice(0, half);
  const recent = filtered.slice(half);

  return {
    earlier: pct(earlier), earlierCount: earlier.length,
    recent: pct(recent), recentCount: recent.length
  };
}

// Speed against accuracy.
//
// secondsSpent has been recorded since the beginning and nothing ever read
// it. It measures the whole cycle - reading the question, deciding, revealing
// and self-grading - so a fixed "under 10 seconds" threshold would mean
// different things on a definition and on a Java exercise. Comparing each
// student's own fastest third against their slowest third avoids that: it
// asks whether rushing costs THEM accuracy, in their own units.
function pacePattern(reviews) {
  const MIN = 12;
  const timed = reviews
    .filter(r => Number(r.secondsSpent) > 0)
    .sort((a, b) => a.secondsSpent - b.secondsSpent);

  if (timed.length < MIN) return null;

  const third = Math.floor(timed.length / 3);
  const fast = timed.slice(0, third);
  const slow = timed.slice(-third);
  const pct = list => Math.round((list.filter(r => r.wasCorrect).length / list.length) * 100);
  const median = list => list[Math.floor(list.length / 2)].secondsSpent;

  const fastSeconds = Math.round(median(fast));
  const slowSeconds = Math.round(median(slow));

  // There has to be a real difference in pace before any claim about pace is
  // worth making. Answering everything in 2 to 5 seconds is one behaviour,
  // not a fast group and a slow group - and splitting it into thirds would
  // still produce two confident-looking percentages built on three seconds of
  // noise. That is exactly the kind of number this app exists to not show.
  const MIN_SLOW_SECONDS = 15;
  const MIN_SPREAD_SECONDS = 10;
  if (slowSeconds < MIN_SLOW_SECONDS || slowSeconds - fastSeconds < MIN_SPREAD_SECONDS) {
    // Say so rather than vanishing. A panel that silently disappears looks
    // broken; this distinguishes "nothing to report" from "nothing here".
    return { tooUniform: true, fastSeconds, slowSeconds };
  }

  return {
    fastAccuracy: pct(fast), fastSeconds, fastCount: fast.length,
    slowAccuracy: pct(slow), slowSeconds, slowCount: slow.length
  };
}

// Exam readiness (30/9, reworked the same day). Two separate questions:
//   coverage  - how much of the course have you practiced?
//   knowledge - of what you practiced, how much do you know?
// One number mixed them: someone who practiced 12 of 40 and knew 9 saw
// "23%", which reads as "you don't know this" when it means "you haven't
// practiced yet". A course with too little practice gets no verdict at all.
//
// Per question, by its LAST answer (one right answer counts at once - the
// student should see results after the first session):
//   known     - right, and you said "I'm sure" / "I think so"
//   fading    - was known, but its review date passed a while ago: memory
//               fades, so it counts half until it's answered again
//   shaky     - right while guessing (luck, not knowledge), or partly right
//   notKnown  - wrong, missed, or "I don't know"
//   sureWrong - of notKnown: you said "I'm sure" (the dangerous ones)
//   unseen    - never practiced
const DAY_MS = 24 * 60 * 60 * 1000;
const READY = { coverage: 0.8, know: 0.8 };
const ON_TRACK_KNOW = 0.6;
const RISK = { days: 14, know: 0.5, perDay: 20, lastDays: 3, lastCoverage: 0.6 };

// Practiced enough to say anything: 10 questions, or a quarter of a small
// course (at least 3) - never more than the course has.
function enoughPracticed(practiced, total) {
  return practiced >= Math.min(total, 10, Math.max(3, Math.ceil(total / 4)));
}

// A known question fades once its review date is well past: half its gap
// (at least a day) of grace, so yesterday's answer isn't "fading" today.
function isFading(item, now) {
  if (!item.dueDate) return false;
  const grace = Math.max(1, Math.round((item.interval || 0) / 2)) * DAY_MS;
  return now - new Date(item.dueDate).getTime() > grace;
}

function readinessOf(items, exam = null, now = Date.now()) {
  const r = { total: items.length, known: 0, fading: 0, shaky: 0, notKnown: 0, unseen: 0, sureWrong: 0 };
  items.forEach(item => {
    const reviews = item.reviews || [];
    const last = reviews[reviews.length - 1];
    if (!last) { r.unseen += 1; return; }
    const partial = last.outcome === 'partial' || last.outcome === 'stuck';
    // Answering a text you've seen before (1/10: no new version was ready)
    // may be remembering the answer: it counts as "known" only if the last
    // answer to a version you hadn't seen was already known.
    const freshAt = reviews.map(rv => rv.fresh !== false).lastIndexOf(true);
    const lastFresh = freshAt >= 0 ? reviews[freshAt] : null;
    const knewFresh = lastFresh && lastFresh.wasCorrect && (lastFresh.confidence === 'sure' || lastFresh.confidence === 'think_so') &&
      !reviews.slice(freshAt + 1).some(rv => !rv.wasCorrect);   // forgotten since: it has to be shown again
    if (last.wasCorrect && (last.confidence === 'sure' || last.confidence === 'think_so') && (last.fresh !== false || knewFresh)) {
      if (isFading(item, now)) r.fading += 1; else r.known += 1;
    } else if (last.wasCorrect || partial) r.shaky += 1;
    else {
      r.notKnown += 1;
      if (last.confidence === 'sure') r.sureWrong += 1;
    }
  });
  const credit = r.known + r.fading / 2;
  r.practiced = r.total - r.unseen;
  r.coverage = r.total ? Math.round((r.practiced / r.total) * 100) : 0;
  // Of what was practiced - null (not 0) before there is anything.
  r.knowPercent = r.practiced ? Math.round((credit / r.practiced) * 100) : null;
  // The whole course, unpracticed counting as unknown (kept for older apps).
  r.percent = r.total ? Math.round((credit / r.total) * 100) : 0;
  r.enoughData = enoughPracticed(r.practiced, r.total);

  // New questions a day to cover the rest before the exam (the exam day
  // itself isn't a study day).
  const daysLeft = exam && Number.isFinite(exam.daysLeft) ? exam.daysLeft : null;
  r.perDay = daysLeft !== null && r.unseen > 0 ? Math.ceil(r.unseen / Math.max(1, daysLeft)) : null;

  // The verdict. Pace comes first: with the exam close and most of the
  // course never practiced, that is the risk - however few answers there
  // are to judge knowledge by.
  const coverage = r.total ? r.practiced / r.total : 0;
  const know = r.practiced ? credit / r.practiced : 0;
  r.reason = null;
  if (daysLeft !== null && daysLeft <= RISK.days && r.perDay !== null &&
      (r.perDay > RISK.perDay || (daysLeft <= RISK.lastDays && coverage < RISK.lastCoverage))) {
    r.status = 'at_risk'; r.reason = 'pace';
  } else if (r.practiced === 0) {
    r.status = 'not_started';
  } else if (!r.enoughData) {
    r.status = 'too_early';
  } else if (coverage >= READY.coverage && know >= READY.know) {
    r.status = 'ready';
  } else if (daysLeft !== null && daysLeft <= RISK.days && know < RISK.know) {
    r.status = 'at_risk'; r.reason = 'knowledge';
  } else if (know >= ON_TRACK_KNOW) {
    r.status = 'on_track';
  } else {
    r.status = 'building';
  }
  return r;
}

// The inverse of "confidently wrong": items you keep doubting yourself on
// but actually know. "Confidently wrong" tells you where your certainty
// lies to you; this tells you where your doubt does - both are the app
// telling the truth about what you actually know, just in opposite
// directions.
//
// Looks at each item's RECENT reviews only (not its whole history) - a
// single early bad guess shouldn't keep an item flagged forever once the
// student has clearly settled into knowing it.
function findUnderconfidentItems(items) {
  const RECENT_WINDOW = 5;
  // Lowered from 3 - with a small/early deck, no single item accumulates 3
  // non-sure reviews quickly, so the panel stayed empty even when the
  // pattern genuinely existed. 2 is still a real track record (not a lucky
  // single guess), just reachable sooner.
  const MIN_NON_SURE_REVIEWS = 2;
  const MIN_ACCURACY = 75;

  return items
    .map(item => {
      const recent = (item.reviews || []).slice(-RECENT_WINDOW);
      const nonSure = recent.filter(r => r.confidence !== 'sure');
      if (nonSure.length < MIN_NON_SURE_REVIEWS) return null;

      const correct = nonSure.filter(r => r.wasCorrect).length;
      const accuracy = Math.round((correct / nonSure.length) * 100);
      if (accuracy < MIN_ACCURACY) return null;

      return {
        id: item._id, question: item.question, category: item.category,
        mode: item.mode, strength: item.strength,
        accuracy, reviewCount: nonSure.length
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.accuracy - a.accuracy || b.reviewCount - a.reviewCount)
    .slice(0, 60);
}

// Genuine difficulty, not a calibration problem. "Confidently wrong" is
// about the mismatch between feeling and reality; this is about items where
// there IS no mismatch - the student correctly recognises they don't know
// it, repeatedly, and repeatedly they're right not to be confident. That is
// a different problem (the material itself, not self-assessment) and
// probably wants a different response: go back to the source, not just
// another rep of the same question.
//
// Excludes anything with a recent "sure" claim - that's the mismatch case
// above, not this one.
function findGenuineDifficultyItems(items) {
  const RECENT_WINDOW = 3;
  const MIN_REVIEWS = 2;
  const MAX_ACCURACY = 30;

  return items
    .map(item => {
      const recent = (item.reviews || []).slice(-RECENT_WINDOW);
      if (recent.length < MIN_REVIEWS) return null;
      if (recent.some(r => r.confidence === 'sure')) return null;

      const correct = recent.filter(r => r.wasCorrect).length;
      const accuracy = Math.round((correct / recent.length) * 100);
      if (accuracy > MAX_ACCURACY) return null;

      return {
        id: item._id, question: item.question, category: item.category,
        mode: item.mode, strength: item.strength,
        accuracy, reviewCount: recent.length
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.accuracy - b.accuracy || b.reviewCount - a.reviewCount)
    .slice(0, 60);
}

// ==========================================
// Mock exams (30/9)
// ==========================================
// A course's questions under exam conditions: typed answers, the check at the
// end, one score. The latest score is the course's "if the exam were today".
const ExamRun = require('../models/ExamRun');
const FullExamRun = require('../models/FullExamRun');
const User = require('../models/User');
const { DEFAULT_DAILY_GOAL } = User;
// A file that IS a past exam: its questions are the closest thing to the
// real one, so they come first.
const PAST_EXAM_FILE = /מבחן|בחינה|מועד|בוחן|\bexams?\b|midterm|quiz|final exam/i;
// ...and not a twin (AI-written after a mistake) that inherited such a file name.
const isPastExam = (i) => !i.twinOf && PAST_EXAM_FILE.test(i.sourceFile || '');
const shuffled = (list) => { const a = list.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// GET /api/study/exam/pick?course=...&count=15
router.get(
  '/exam/pick',
  asyncHandler(async (req, res) => {
    const course = String(req.query.course || '').trim();
    if (!course) throw new ApiError(400, 'course is required');
    const count = Math.min(Math.max(parseInt(req.query.count, 10) || 15, 3), 40);
    const all = (await StudyItem.find({ userId: req.userId, suspended: false }).select('-reviews').lean())
      .filter(i => courseOf(i) === course || (i.category || '') === course);
    // Past-exam questions first (up to half), then the rest spread across
    // topics - a real exam covers the course, not one chapter.
    const past = shuffled(all.filter(isPastExam));
    const picked = past.slice(0, Math.ceil(count / 2));
    const byTopic = new Map();
    for (const i of shuffled(all.filter(i => !picked.includes(i)))) {
      const key = i.skillTag || i.sourceFile || '';
      if (!byTopic.has(key)) byTopic.set(key, []);
      byTopic.get(key).push(i);
    }
    const lanes = [...byTopic.values()];
    while (picked.length < count && lanes.some(l => l.length)) {
      for (const lane of lanes) { if (lane.length && picked.length < count) picked.push(lane.shift()); }
    }
    res.json(shuffled(picked).map(i => ({
      id: String(i._id), question: i.question, answer: i.answer || i.mySolution || '', mode: i.mode,
      solutionSource: i.solutionSource, skillTag: i.skillTag || '', sourceFile: i.sourceFile || '',
      fromPastExam: isPastExam(i)
    })));
  })
);

// Score: correct = 1, partial = 1/2, wrong or blank = 0, over the answers
// that were checked. The margin is one standard error - with 10 questions a
// score is honestly rough, and saying so is the point.
function examScore(answers) {
  const inScore = answers.filter(a => a.verdict !== 'unchecked');
  const n = inScore.length;
  if (!n) return { checked: 0, score: 0, margin: 0 };
  const points = inScore.reduce((sum, a) => sum + (a.verdict === 'correct' ? 1 : a.verdict === 'partial' ? 0.5 : 0), 0);
  const p = points / n;
  return { checked: n, score: Math.round(p * 100), margin: Math.round(100 * Math.sqrt(Math.max(p * (1 - p), 0.04) / n)) };
}

// POST /api/study/exam/runs  { course, startedAt, limitSec, usedSec, answers: [{ itemId, confidence, verdict }] }
// Saves the run, and every checked answer also counts as practice for that
// question (so the schedule learns from the exam too).
router.post(
  '/exam/runs',
  asyncHandler(async (req, res) => {
    const course = String(req.body.course || '').trim().slice(0, 100);
    const raw = Array.isArray(req.body.answers) ? req.body.answers.slice(0, 40) : [];
    if (!course || !raw.length) throw new ApiError(400, 'course and answers are required');
    const VERDICTS = ['correct', 'partial', 'wrong', 'blank', 'unchecked'];
    const CONF = ['sure', 'think_so', 'guessing', 'none'];
    // Sent twice (a retry after a timeout): the first one stands.
    const clientRunId = typeof req.body.clientRunId === 'string' ? req.body.clientRunId.slice(0, 40) : null;
    if (clientRunId) {
      const already = await ExamRun.findOne({ userId: req.userId, clientRunId });
      if (already) return res.status(200).json(already);
    }
    const ids = [...new Set(raw.map(a => a && a.itemId).filter(id => typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id)))];
    // Only this course's questions count toward this course's score.
    const items = (await StudyItem.find({ _id: { $in: ids }, userId: req.userId }))
      .filter(i => courseOf(i) === course || (i.category || '') === course);
    const byId = new Map(items.map(i => [String(i._id), i]));
    const seen = new Set();
    const answers = raw.map(a => {
      const id = a && String(a.itemId);
      const item = id && byId.get(id);
      if (!item || seen.has(id)) return null;   // each question once
      seen.add(id);
      return {
        itemId: item._id,
        question: String(item.question || '').slice(0, 600),
        topic: String(item.skillTag || '').slice(0, 120),
        confidence: CONF.includes(a.confidence) ? a.confidence : 'none',
        verdict: VERDICTS.includes(a.verdict) ? a.verdict : 'unchecked'
      };
    }).filter(Boolean);
    if (!answers.length) throw new ApiError(400, 'None of these questions were found in this course');

    const started = new Date(req.body.startedAt);
    // The run first; then each checked answer counts as practice too (a
    // failure in between leaves a run without practice, never the reverse).
    const run = await ExamRun.create({
      userId: req.userId, course, clientRunId,
      startedAt: Number.isNaN(started.getTime()) ? new Date() : started,
      finishedAt: new Date(),
      limitSec: Math.max(0, Math.min(Number(req.body.limitSec) || 0, 6 * 3600)),
      usedSec: Math.max(0, Math.min(Number(req.body.usedSec) || 0, 6 * 3600)),
      answers,
      ...examScore(answers)
    });
    for (const a of answers) {
      if (a.verdict === 'unchecked') continue;
      const item = byId.get(String(a.itemId));
      const practice = item.mode === 'practice';
      const outcome = a.verdict === 'correct' ? (practice ? 'solved' : 'got_it')
        : a.verdict === 'partial' ? (practice ? 'stuck' : 'partial')
          : (practice ? 'wrong' : 'missed');
      const confidence = a.verdict === 'blank' || a.confidence === 'none' ? 'dont_know' : a.confidence;
      // aiSuggested stays empty: nobody could overrule the check in an exam,
      // so it would read as "agreed with the AI" on the owner's page.
      try {
        await recordReview(req.userId, item, { confidence, outcome });
      } catch (err) { console.warn('mock exam: review not saved:', err.message); }
    }
    // History: the last 20 per course.
    const old = await ExamRun.find({ userId: req.userId, course }).sort({ finishedAt: -1 }).skip(20).select('_id').lean();
    if (old.length) await ExamRun.deleteMany({ _id: { $in: old.map(o => o._id) } });
    res.status(201).json(run);
  })
);

// GET /api/study/exam/runs?course=...
router.get(
  '/exam/runs',
  asyncHandler(async (req, res) => {
    const filter = { userId: req.userId };
    if (req.query.course) filter.course = String(req.query.course);
    const runs = await ExamRun.find(filter).sort({ finishedAt: -1 }).limit(20).select('-answers').lean();
    res.json(runs);
  })
);

// GET /api/study/due?limit=20&category=...&sourceFile=...&all=1
// The study session queue.
//
// CHANGED (exam-aware): it used to be "everything whose dueDate has passed,
// most overdue first". Now (utils/examSchedule.js):
//   - the course with the nearest exam comes first,
//   - a question scheduled for after its course's exam counts as due the day
//     before the exam,
//   - new (never answered) questions come in at a daily pace instead of all
//     at once - 40 fresh questions from one file used to be "40 due today".
router.get(
  '/due',
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const category = req.query.category || null;
    let items = await StudyItem.find({ userId: req.userId, suspended: false });
    // ?sourceFile=... : only the questions made from that one file.
    // (?sourceFile= with nothing after it: the questions written by hand)
    if (typeof req.query.sourceFile === 'string') items = items.filter(i => (i.sourceFile || '') === req.query.sourceFile);

    // ?all=1 - "Practice anyway": everything in the chosen course/file, not
    // only what is due. For the night before an exam, when the schedule says
    // "nothing yet" but the student wants to go over it all. Due soonest
    // first (closest to being forgotten), never-answered ones after.
    if (req.query.all) {
        const inScope = category ? items.filter(i => courseOf(i) === category || (i.category || '') === category) : items;
        const isNew = (i) => !(i.reviews && i.reviews.length);
        const time = (d) => (d ? new Date(d).getTime() : 0);
        inScope.sort((a, b) => (isNew(a) - isNew(b)) || time(a.dueDate) - time(b.dueDate) || time(a.createdAt) - time(b.createdAt));
        return res.json(inScope.slice(0, limit));
    }

    const courses = [...new Set(items.map(courseOf))];
    const exams = await examsForCourses(req.userId, courses);
    const { queue } = buildStudyQueue(items, exams, new Date(), { limit, category });
    res.json(queue);
  })
);

// GET /api/study - full list, with optional filters
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { userId: req.userId };
    if (req.query.category) filter.category = req.query.category;
    if (req.query.mode) filter.mode = req.query.mode;

    // ?light=1 drops the review history, which is by far the largest field on
    // a well-used item and the one nothing on the manage screen reads. On a
    // deck with a few hundred reviewed questions this is the difference
    // between a visible pause and an instant list.
    const query = StudyItem.find(filter).sort({ createdAt: -1 });
    if (req.query.light) query.select('-reviews');

    res.json(await query);
  })
);

// GET /api/study/stats - deck overview + calibration
// When today began on the app's clock (Israel - like the planner's "today").
function startOfAppDay(now = new Date()) {
  const clock = (d) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone: APP_TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(d).map(x => [x.type, x.value]));
    return (Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000;
  };
  let start = new Date(now.getTime() - clock(now) - now.getMilliseconds());
  // On the day the clock moves (daylight saving), that lands an hour off
  // midnight: 23:00 the day before, or 01:00 - one step fixes it.
  const off = clock(start);
  if (off) start = new Date(start.getTime() + (off > 12 * 3600000 ? 86400000 - off : -off));
  return start;
}

// GET /api/study/today   (3/10, the daily goal)
// { answered, goal }: questions answered today - in practice, in mock exams
// and in full exams. Nothing is counted twice:
//  - a mock exam saves its checked answers as reviews too (POST /exam/runs),
//    so they come with the reviews - except its blank ones (skipped or out
//    of time, saved as "I don't know"), taken off as in a full exam, where a
//    blank part doesn't count; and its unchecked ones (no review) are added,
//    as a full exam's unchecked written parts count;
//  - a full exam saves no reviews: each part written, chosen, "I don't know"
//    or from a photo counts.
// No streaks: tomorrow starts again from 0, no penalty.
router.startOfAppDay = startOfAppDay;   // (for tests)
router.get(
  '/today',
  asyncHandler(async (req, res) => {
    const since = startOfAppDay();
    const [items, mocks, fulls, user] = await Promise.all([
      StudyItem.find({ userId: req.userId, 'reviews.reviewedAt': { $gte: since } }).select('reviews.reviewedAt').lean(),
      ExamRun.find({ userId: req.userId, finishedAt: { $gte: since } }).select('answers.verdict').lean(),
      FullExamRun.find({ userId: req.userId, finishedAt: { $gte: since } }).select('answers').lean(),
      User.findById(req.userId).select('dailyGoal').lean()
    ]);
    let answered = 0;
    for (const i of items) answered += (i.reviews || []).filter(r => r.reviewedAt && new Date(r.reviewedAt) >= since).length;
    for (const r of mocks) {
      for (const a of r.answers || []) {
        if (a.verdict === 'blank') answered -= 1;
        else if (a.verdict === 'unchecked') answered += 1;
      }
    }
    answered = Math.max(0, answered);   // (a blank whose review failed to save)
    for (const r of fulls) {
      answered += (r.answers || []).filter(a => a.status !== 'not_chosen'
        && (String(a.text || '').trim() || a.choice || a.dontKnow || a.fromPhoto)).length;
    }
    res.json({ answered, goal: (user && user.dailyGoal) || DEFAULT_DAILY_GOAL });
  })
);

router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const now = new Date();
    const items = await StudyItem.find({ userId: req.userId, suspended: false });

    // Same logic as the session queue (/due), so the number on the screen is
    // the number of questions a session will actually go through.
    const courses = [...new Set(items.map(courseOf))];
    const exams = await examsForCourses(req.userId, courses);
    const plan = buildStudyQueue(items, exams, now, { limit: Number.MAX_SAFE_INTEGER });
    const dueCount = plan.total;
    // Count items never actually seen, not items whose streak was reset.
    // SM-2 sets repetitions back to 0 on a failure, so counting that field
    // made a question you got wrong reappear as "never reviewed" - which is
    // both wrong and demoralising.
    const newCount = items.filter(i => !i.reviews || i.reviews.length === 0).length;

    // Flatten every review across every item for the calibration report.
    const allReviews = items.flatMap(i => i.reviews || []);
    const calibration = calibrationReport(allReviews);

    // Calibration per subject.
    //
    // The global report above answers "is my sense of what I know reliable?".
    // This answers "WHERE is it unreliable?" - which is the question that
    // changes what the student does tonight. Someone well calibrated in graph
    // theory and badly calibrated in linear algebra learns nothing from the
    // average of the two: it reads as a mild problem everywhere instead of a
    // real one in one place.
    //
    // This replaces the old `weakTopics` block, which nothing on the client
    // ever rendered. It also ranked by raw accuracy from as few as 3 reviews,
    // which in a product about telling the truth is a number that lies.
    const byCategory = {};
    items.forEach(item => {
      const key = courseOf(item);
      if (!byCategory[key]) {
        byCategory[key] = { items: 0, reviews: 0, correct: 0, sureReviews: 0, sureCorrect: 0, lapses: 0, neverReviewed: 0, reviewList: [] };
      }
      const b = byCategory[key];
      b.items += 1;
      b.lapses += item.lapses;
      if (!item.reviews || item.reviews.length === 0) b.neverReviewed += 1;
      (item.reviews || []).forEach(r => {
        b.reviews += 1;
        b.reviewList.push(r);
        if (r.wasCorrect) b.correct += 1;
        // The headline number: how often "I'm sure" was actually right.
        if (r.confidence === 'sure') {
          b.sureReviews += 1;
          if (r.wasCorrect) b.sureCorrect += 1;
        }
      });
    });

    // Below these counts a percentage is noise. One bad evening in a subject
    // you have barely touched is not a knowledge gap, and showing it as one
    // would undermine the only thing this panel claims to do.
    // Kept in step with CALIBRATION_MIN_REVIEWS on the client: a subject the
    // client is willing to show a calibration panel for must actually get a
    // row here, or selecting it shows nothing at all.
    const SUBJECT_MIN_REVIEWS = 5;
    const SUBJECT_MIN_SURE = 4;

    const subjectCalibration = Object.entries(byCategory)
      .filter(([, v]) => v.reviews >= SUBJECT_MIN_REVIEWS)
      .map(([name, v]) => ({
        category: name,
        items: v.items,
        total: v.reviews,
        correct: v.correct,
        accuracy: Math.round((v.correct / v.reviews) * 100),
        sureTotal: v.sureReviews,
        sureCorrect: v.sureCorrect,
        // null rather than 0: "not enough data" and "wrong every time" must
        // never reach the client as the same value.
        sureAccuracy: v.sureReviews >= SUBJECT_MIN_SURE
          ? Math.round((v.sureCorrect / v.sureReviews) * 100)
          : null,
        // The same three-bucket report as the deck-wide one, scoped to this
        // subject - so selecting a subject can show a calibration panel about
        // that subject instead of an average across courses the student is
        // not studying tonight.
        calibration: calibrationReport(v.reviewList),
        trend: confidenceTrend(v.reviewList, 'sure'),
        pace: pacePattern(v.reviewList),
        lapses: v.lapses
      }))
      // Worst first, with the not-yet-measurable subjects last. Alphabetical
      // order would bury the subject that matters under whatever starts
      // with 'A'.
      .sort((a, b) => {
        if (a.sureAccuracy === null && b.sureAccuracy === null) return a.accuracy - b.accuracy;
        if (a.sureAccuracy === null) return 1;
        if (b.sureAccuracy === null) return -1;
        return a.sureAccuracy - b.sureAccuracy;
      });

    // One row per subject, so the study screen can offer a course at a time.
    // Nearest exam first, then by what is actually waiting.
    // Items per course, grouped once (30/9: filtering all items once per
    // course was O(courses x items) - seconds of frozen server with many).
    const itemsByCourse = new Map();
    items.forEach(i => { const k = courseOf(i); if (!itemsByCourse.has(k)) itemsByCourse.set(k, []); itemsByCourse.get(k).push(i); });
    // Files in a course's folder that no question came from (30/9):
    // readiness only knows the questions that exist, so material with none
    // yet is said out loud rather than silently missing. Questions made
    // from a file carry its folder as their course and its name as source.
    const filesWithout = {};
    try {
      const withSource = new Set(items.map(i => `${courseOf(i)}\u0000${i.sourceFile || ''}`));
      const files = await FileItem.find({ userId: req.userId, folder: { $in: [...itemsByCourse.keys()] } }).select('name folder').lean();
      files.forEach(f => {
        if (!withSource.has(`${f.folder}\u0000${f.name}`)) filesWithout[f.folder] = (filesWithout[f.folder] || 0) + 1;
      });
    } catch (err) {
      console.warn('study stats: file count skipped:', err.message);
    }
    // The latest mock exam per course (30/9) - "if the exam were today".
    const lastMock = {};
    try {
      const runs = await ExamRun.find({ userId: req.userId }).sort({ finishedAt: -1 }).limit(200).select('course score margin checked finishedAt').lean();
      for (const r of runs) if (!lastMock[r.course]) lastMock[r.course] = { score: r.score, margin: r.margin, checked: r.checked, at: r.finishedAt };
    } catch (err) { console.warn('study stats: mock exams skipped:', err.message); }
    const subjects = Object.entries(byCategory)
      .map(([name, v]) => {
        const c = plan.byCourse[name] || { dueReviews: 0, newToday: 0, unseen: 0, exam: null };
        return {
          category: name,
          items: v.items,
          readiness: { ...readinessOf(itemsByCourse.get(name) || [], c.exam, now.getTime()), filesWithoutQuestions: filesWithout[name] || 0 },
          due: Number.isInteger(c.queued) ? c.queued : c.dueReviews + c.newToday,
          dueReviews: c.dueReviews,
          newToday: c.newToday,
          neverReviewed: v.neverReviewed,
          // { title, date: 'YYYY-MM-DD', daysLeft } or null
          exam: c.exam || null,
          lastMock: lastMock[name] || null
        };
      })
      .sort((a, b) =>
        (a.exam ? a.exam.daysLeft : Infinity) - (b.exam ? b.exam.daysLeft : Infinity)
        || b.due - a.due || b.items - a.items || a.category.localeCompare(b.category));

    // Confidently wrong: the single most useful list in the app. These are
    // the things you believe you know and don't.
    const confidentlyWrong = items
      .filter(i => (i.reviews || []).some(r => r.confidence === 'sure' && !r.wasCorrect))
      .map(i => ({
        id: i._id,
        question: i.question,
        category: i.category,
        mode: i.mode,
        strength: i.strength
      }))
      // Capped generously rather than tightly: the client narrows this to
      // the selected subject, and a hard limit of 10 across the whole deck
      // could leave a single subject looking empty.
      .slice(0, 60);

    res.json({
      totalItems: items.length,
      dueCount,
      newCount,
      reviewsAllTime: allReviews.length,
      calibration,
      trend: confidenceTrend(allReviews, 'sure'),
      trendByConfidence: {
        sure: confidenceTrend(allReviews, 'sure'),
        think_so: confidenceTrend(allReviews, 'think_so'),
        guessing: confidenceTrend(allReviews, 'guessing')
      },
      pace: pacePattern(allReviews),
      subjects,
      subjectCalibration,
      confidentlyWrong,
      underconfidentItems: findUnderconfidentItems(items),
      genuineDifficultyItems: findGenuineDifficultyItems(items)
    });
  })
);

// GET /api/study/variant-candidates?when=today|tomorrow   (1/10)
// The questions that need a new version written before they come up: in
// today's (or tomorrow's) queue, answered at least once, not a "what does X
// mean" item, and without a version waiting already. The app writes the
// versions in one or two AI requests and saves them with PUT /:id/variant.
router.get(
  '/variant-candidates',
  asyncHandler(async (req, res) => {
    const when = req.query.when === 'tomorrow' ? 'tomorrow' : 'today';
    const items = await StudyItem.find({ userId: req.userId, suspended: false });
    const courses = [...new Set(items.map(courseOf))];
    const exams = await examsForCourses(req.userId, courses);
    const at = new Date(Date.now() + (when === 'tomorrow' ? DAY_MS : 0));
    const { queue } = buildStudyQueue(items, exams, at, { limit: 24 });
    const out = queue
      .filter(i => i.reviews && i.reviews.length && i.kind !== 'know' && !(i.nextVariant && i.nextVariant.question) &&
        !(i.variantFailedAt && Date.now() - new Date(i.variantFailedAt).getTime() < 3 * DAY_MS))
      .map(i => ({ id: String(i._id), question: i.question, answer: i.answer, mode: i.mode, skillTag: i.skillTag, category: i.category, kind: i.kind, solutionSource: i.solutionSource, pastVersions: i.pastVersions || [] }));
    res.json(out);
  })
);

// PUT /api/study/:id/variant   { question, answer, solutionSource }   (1/10)
//   { keep: true }   - the AI says it only asks what a term means: shown as
//                      it is from now on (kind "know"), never sent again.
//   { failed: true } - no usable version came back: not asked for 3 days.
router.put(
  '/:id/variant',
  asyncHandler(async (req, res) => {
    const item = await StudyItem.findOne({ _id: req.params.id, userId: req.userId });
    if (!item) throw new ApiError(404, 'Study item not found');
    if (req.body.keep === true || req.body.failed === true) {
      if (req.body.keep === true) item.kind = 'know';
      else item.variantFailedAt = new Date();
      await item.save({ validateModifiedOnly: true });
      return res.json({ id: String(item._id), kind: item.kind });
    }
    const question = String(req.body.question || '').trim();
    const answer = String(req.body.answer || '').trim();
    if (question.length < 10 || question.length > 2000 || !answer || answer.length > 4000) throw new ApiError(400, 'A version needs a question (10-2000 characters) and an answer (up to 4000).');
    if (question === item.question.trim()) throw new ApiError(400, 'That is the same question.');
    // One waiting at a time: two writers at once (today's and tomorrow's)
    // must not swap the text a session already has on screen.
    if (item.nextVariant && item.nextVariant.question) throw new ApiError(409, 'A new version is already waiting.');
    item.nextVariant = { question, answer, solutionSource: req.body.solutionSource === 'document' ? 'document' : 'ai', createdAt: new Date() };
    await item.save({ validateModifiedOnly: true });
    res.json({ id: String(item._id), nextVariant: item.nextVariant });
  })
);

// GET /api/study/categories
router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const categories = await StudyItem.distinct('category', { userId: req.userId, category: { $ne: '' } });
    res.json(categories.sort());
  })
);

// POST /api/study - create one item
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { question, answer, mode, skillTag, category, sourceFile } = req.body;
    await assertRoom(StudyItem, req.userId);
    const item = await StudyItem.create({ userId: req.userId, question, answer, mode, skillTag, category, sourceFile });
    res.status(201).json(item);
  })
);

// POST /api/study/bulk - create many at once (used by AI generation)
router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const { items } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      throw new ApiError(400, 'items must be a non-empty array');
    }
    if (items.length > 200) throw new ApiError(400, 'Too many items in one request (max 200)');
    await assertRoom(StudyItem, req.userId, items.length);

    // Fitted to the model's limits first (30/9): insertMany with ordered:false
    // SKIPS an item that fails validation, silently - a full worked solution
    // over 4000 characters just vanished while the app said "added".
    const fit = (v, max) => { const t = String(v || '').trim(); return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t; };
    const created = await StudyItem.insertMany(
      items.filter(i => i && String(i.question || '').trim()).map(i => ({
        userId: req.userId,
        question: fit(i.question, 2000),
        answer: fit(i.answer, 4000),
        mode: ['recall', 'practice', 'explain'].includes(i.mode) ? i.mode : 'recall',
        solutionSource: ['document', 'ai', 'user', 'imported', 'none'].includes(i.solutionSource) ? i.solutionSource : 'document',
        skillTag: fit(i.skillTag, 120),
        category: fit(i.category, 100),
        sourceFile: fit(i.sourceFile, 300),
        twinOf: typeof i.twinOf === 'string' && /^[a-f0-9]{24}$/i.test(i.twinOf) ? i.twinOf : null,
        kind: ['know', 'understand', 'practice'].includes(i.kind) ? i.kind : ''
      })),
      { ordered: false } // one bad item shouldn't reject the whole batch
    );

    res.status(201).json({ created: created.length, items: created });
  })
);

// POST /api/study/bulk-delete   { ids: [...] }
// Declared before '/:id' routes so "bulk-delete" isn't matched as an id.
// Deleting a whole generated set is the common case - a bad batch of
// AI-generated questions should be removable in one action, not one by one.
router.post(
  '/bulk-delete',
  asyncHandler(async (req, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ApiError(400, 'ids must be a non-empty array');
    }
    // BUG FIX: scoped by userId too. Without it, sending someone else's
    // (guessed or leaked) item ids in this array would delete their
    // questions, not just your own.
    const result = await StudyItem.deleteMany({ _id: { $in: ids }, userId: req.userId });
    res.json({ success: true, deleted: result.deletedCount });
  })
);

// DELETE /api/study/all/everything
// Wipes the CALLER's deck. Declared before '/:id' so "all" isn't read as an id.
// The UI deliberately gates this behind a typed confirmation - it destroys
// every question AND all the review history behind them, which is the part
// that can't be regenerated.
router.delete(
  '/all/everything',
  asyncHandler(async (req, res) => {
    // BUG FIX: this used to be deleteMany({}) with no filter - "wipe my
    // deck" would have wiped every user's study items.
    const result = await StudyItem.deleteMany({ userId: req.userId });
    await ExamRun.deleteMany({ userId: req.userId });   // their mock exams go with them
    res.json({ success: true, deleted: result.deletedCount });
  })
);

// One answer recorded and the question rescheduled - for practice and for
// mock exams alike (30/9). The course's next exam caps how far away the next
// review can be.
async function recordReview(userId, item, { confidence, outcome, aiSuggested = null, clientId, secondsSpent = 0, variantShown = false }) {
  // A new version was on screen (1/10): it becomes a past version, and the
  // answer counts as "fresh" - so does the very first answer to a question.
  const shownVariant = variantShown && item.nextVariant && item.nextVariant.question ? item.nextVariant.question : null;
  // Also fresh: a "what does this term mean" item (remembering IS the point
  // there), and the same text after a week or more - a specific answer is
  // long forgotten by then, and an item that never gets a version (no cloud
  // AI, mock exams) can still become "known".
  const prev = item.reviews && item.reviews.length ? item.reviews[item.reviews.length - 1] : null;
  const fresh = Boolean(shownVariant) || !prev || item.kind === 'know' ||
    Date.now() - new Date(prev.reviewedAt).getTime() >= 7 * DAY_MS;
  if (shownVariant) {
    item.pastVersions = [...(item.pastVersions || []), String(shownVariant).slice(0, 400)].slice(-6);
    item.nextVariant = null;
  }
  const course = courseOf(item);
  const exam = (await examsForCourses(userId, [course]))[course] || null;
  const next = schedule(item, outcome, confidence, exam ? { daysUntilExam: exam.daysLeft, examDate: exam.date } : {});
  item.reviews.push({
    confidence,
    outcome,
    wasCorrect: OUTCOME_CORRECT[outcome],
    aiSuggested,
    clientId: typeof clientId === 'string' ? clientId.slice(0, 40) : undefined,
    secondsSpent: Math.min(Math.max(Number(secondsSpent) || 0, 0), 24 * 3600),
    reviewedAt: new Date(),
    fresh
  });
  // Keep the recent history only (30/9): answering the same question in a
  // loop used to grow one document without end.
  if (item.reviews.length > 300) item.reviews.splice(0, item.reviews.length - 300);
  item.interval = next.interval;
  item.ease = next.ease;
  item.repetitions = next.repetitions;
  item.lapses = next.lapses;
  item.dueDate = next.dueDate;
  await item.save({ validateModifiedOnly: true });
  return { next, exam };
}

// POST /api/study/:id/review   { confidence, outcome, secondsSpent }
// The heart of the system: records the attempt and reschedules.
router.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const { confidence, outcome, secondsSpent } = req.body;
    // The AI check's own call, if there was one - anything else is ignored.
    const isOutcome = (v) => typeof v === 'string' && Object.prototype.hasOwnProperty.call(OUTCOME_CORRECT, v);
    const aiSuggested = isOutcome(req.body.aiSuggested) ? req.body.aiSuggested : null;

    // dont_know: the "I don't know" button - always saved as missed/wrong.
    const VALID_CONFIDENCE = ['sure', 'think_so', 'guessing', 'dont_know'];
    if (!VALID_CONFIDENCE.includes(confidence)) {
      throw new ApiError(400, `confidence must be one of: ${VALID_CONFIDENCE.join(', ')}`);
    }
    if (!isOutcome(outcome)) {   // hasOwnProperty: "toString" is `in` every object
      throw new ApiError(400, `outcome must be one of: ${Object.keys(OUTCOME_CORRECT).join(', ')}`);
    }

    // "I don't know" can't be "got it" (30/9) - it would advance the schedule.
    if (confidence === 'dont_know' && OUTCOME_CORRECT[outcome]) {
      throw new ApiError(400, "An \"I don't know\" answer can't be marked as known");
    }

    const item = await StudyItem.findOne({ _id: req.params.id, userId: req.userId });
    if (!item) throw new ApiError(404, 'Study item not found');

    // The same answer sent twice (a retry after a slow server that DID save
    // the first one, 30/9): saved once, so the schedule doesn't jump twice.
    const lastReview = item.reviews && item.reviews[item.reviews.length - 1];
    if (lastReview && lastReview.confidence === confidence && lastReview.outcome === outcome
        && Date.now() - new Date(lastReview.reviewedAt).getTime() < 90 * 1000
        && req.body.clientId && lastReview.clientId === req.body.clientId) {
      return res.json({ item, grade: null, nextInterval: item.interval, cappedForExam: null, wasOverconfident: confidence === 'sure' && !OUTCOME_CORRECT[outcome], duplicate: true });
    }

    const { next, exam } = await recordReview(req.userId, item, { confidence, outcome, aiSuggested, clientId: req.body.clientId, secondsSpent, variantShown: req.body.variantShown === true });

    res.json({
      item,
      grade: next.grade,
      nextInterval: next.interval,
      // Set when the exam shortened the gap, so the client could say
      // "back before your exam on 1/12" instead of a bare interval.
      cappedForExam: next.cappedForExam ? { title: exam.title, date: exam.date } : null,
      // Surfaced immediately so the moment of realisation happens right
      // then, not buried in a stats screen later.
      wasOverconfident: confidence === 'sure' && !OUTCOME_CORRECT[outcome]
    });
  })
);

// PUT /api/study/:id
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { question, answer, mode, skillTag, category, suspended, mySolution, solutionSource } = req.body;
    // The student rewrote the question or its answer: a version written from
    // the old text no longer fits (1/10).
    const edited = question !== undefined || answer !== undefined || mode !== undefined;
    const item = await StudyItem.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { question, answer, mode, skillTag, category, suspended, mySolution, solutionSource, ...(edited ? { nextVariant: null } : {}) },
      { new: true, runValidators: true, omitUndefined: true }
    );
    if (!item) throw new ApiError(404, 'Study item not found');
    res.json(item);
  })
);

// DELETE /api/study/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const item = await StudyItem.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!item) throw new ApiError(404, 'Study item not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;