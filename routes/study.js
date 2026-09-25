const express = require('express');
const router = express.Router();
const StudyItem = require('../models/StudyItem');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { schedule, calibrationReport, OUTCOME_CORRECT } = require('../utils/scheduler');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

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

// GET /api/study/due?limit=20&category=...
// The study session queue. Ordered so the most overdue comes first.
router.get(
  '/due',
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const filter = { userId: req.userId, suspended: false, dueDate: { $lte: new Date() } };
    if (req.query.category) filter.category = req.query.category;

    let items = await StudyItem.find(filter).sort({ dueDate: 1 }).limit(limit * 2);

    // For practice items, only surface ONE per skillTag per session. Drilling
    // five near-identical integrals back to back teaches the specific
    // answers, not the skill.
    const seenSkills = new Set();
    items = items.filter(item => {
      if (item.mode !== 'practice' || !item.skillTag) return true;
      if (seenSkills.has(item.skillTag)) return false;
      seenSkills.add(item.skillTag);
      return true;
    }).slice(0, limit);

    res.json(items);
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
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const now = new Date();
    const items = await StudyItem.find({ userId: req.userId, suspended: false });

    const dueCount = items.filter(i => i.dueDate <= now).length;
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
      const key = (item.category || '').trim() || 'Uncategorized';
      if (!byCategory[key]) {
        byCategory[key] = { items: 0, reviews: 0, correct: 0, sureReviews: 0, sureCorrect: 0, lapses: 0, due: 0, neverReviewed: 0, reviewList: [] };
      }
      const b = byCategory[key];
      b.items += 1;
      b.lapses += item.lapses;
      // Per-subject workload, so the client can show what each course costs
      // tonight without fetching the whole deck.
      if (item.dueDate <= now) b.due += 1;
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
    // Sorted by what is actually waiting rather than alphabetically: the
    // subject with thirty questions due is the one the student came for.
    const subjects = Object.entries(byCategory)
      .map(([name, v]) => ({
        category: name,
        items: v.items,
        due: v.due,
        neverReviewed: v.neverReviewed
      }))
      .sort((a, b) => b.due - a.due || b.items - a.items || a.category.localeCompare(b.category));

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

    const created = await StudyItem.insertMany(
      items.map(i => ({
        userId: req.userId,
        question: i.question,
        answer: i.answer || '',
        mode: ['recall', 'practice', 'explain'].includes(i.mode) ? i.mode : 'recall',
        solutionSource: ['document', 'ai', 'user', 'imported', 'none'].includes(i.solutionSource) ? i.solutionSource : 'document',
        skillTag: i.skillTag || '',
        category: i.category || '',
        sourceFile: i.sourceFile || ''
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
    res.json({ success: true, deleted: result.deletedCount });
  })
);

// POST /api/study/:id/review   { confidence, outcome, secondsSpent }
// The heart of the system: records the attempt and reschedules.
router.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    const { confidence, outcome, secondsSpent } = req.body;

    const VALID_CONFIDENCE = ['sure', 'think_so', 'guessing'];
    if (!VALID_CONFIDENCE.includes(confidence)) {
      throw new ApiError(400, `confidence must be one of: ${VALID_CONFIDENCE.join(', ')}`);
    }
    if (!(outcome in OUTCOME_CORRECT)) {
      throw new ApiError(400, `outcome must be one of: ${Object.keys(OUTCOME_CORRECT).join(', ')}`);
    }

    const item = await StudyItem.findOne({ _id: req.params.id, userId: req.userId });
    if (!item) throw new ApiError(404, 'Study item not found');

    const next = schedule(item, outcome, confidence);

    item.reviews.push({
      confidence,
      outcome,
      wasCorrect: OUTCOME_CORRECT[outcome],
      secondsSpent: Number(secondsSpent) || 0,
      reviewedAt: new Date()
    });

    item.interval = next.interval;
    item.ease = next.ease;
    item.repetitions = next.repetitions;
    item.lapses = next.lapses;
    item.dueDate = next.dueDate;

    await item.save();

    res.json({
      item,
      grade: next.grade,
      nextInterval: next.interval,
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
    const item = await StudyItem.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { question, answer, mode, skillTag, category, suspended, mySolution, solutionSource },
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