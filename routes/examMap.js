// "What repeats in the exam" (3/10) - utils/examMap.js, models/CourseProfile.js.
// The app runs the AI (the past-exam analysis, the linking); this keeps the
// result per user and course and joins it with the student's answers.
const express = require('express');
const router = express.Router();
const CourseProfile = require('../models/CourseProfile');
const StudyItem = require('../models/StudyItem');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');
const { topicStats, needsLink, courseSkills } = require('../utils/examMap');

router.use(requireAuth);

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const courseOf = (item) => (item.category || '').trim() || 'Uncategorized';
const courseItems = async (userId, course) => (await StudyItem.find({ userId, suspended: false })
  .select('category skillTag reviews.wasCorrect reviews.reviewedAt reviews.examBlank').lean()).filter(i => courseOf(i) === course);

// GET /api/exam-map?course=...
// { profile: { recurring, pastExams, analyzedAt, linkedAt } | null, topics, needsLink, skills }
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const course = str(req.query.course, 100);
    if (!course) throw new ApiError(400, 'course is required');
    const [profile, items] = await Promise.all([
      CourseProfile.findOne({ userId: req.userId, course }).lean(),
      courseItems(req.userId, course)
    ]);
    res.json({
      profile: profile ? { recurring: profile.recurring, pastExams: profile.pastExams, analyzedAt: profile.analyzedAt, linkedAt: profile.linkedAt } : null,
      topics: topicStats(profile, items),
      needsLink: needsLink(profile, items),
      skills: profile ? courseSkills(items, undefined, new Set(profile.linkedSkills || [])) : []
    });
  })
);

// PUT /api/exam-map/profile   { course, recurring, pastExams } - a new analysis.
// Links of topics that are still there are kept.
router.put(
  '/profile',
  asyncHandler(async (req, res) => {
    const course = str(req.body.course, 100);
    if (!course) throw new ApiError(400, 'course is required');
    const pastExams = (Array.isArray(req.body.pastExams) ? req.body.pastExams : []).slice(0, 12).map(f => str(f, 300)).filter(Boolean);
    // "in 7 of 8 exams" can't be more exams than were analysed (the AI's
    // count is capped by the files it was given).
    const files = pastExams.length || 50;
    const known = new Set(pastExams);
    // With "exams" (the files that ask it): count is how many of them are
    // analysed files. Without: the count as sent - one over its own "of"
    // contradicts itself and is dropped, not repaired.
    const recurring = (Array.isArray(req.body.recurring) ? req.body.recurring : []).slice(0, 12)
      .filter(r => r && (Array.isArray(r.exams) || (Number(r.count) || 0) <= (Number(r.of) || 0)))
      .map(r => {
        const of = Math.max(0, Math.min(files, Number(r.of) || 0));
        // (not de-duplicated: two files may share a name - the app counted each file once)
        const exams = Array.isArray(r.exams) ? r.exams.map(n => str(n, 300)).filter(n => known.has(n)).slice(0, of) : null;
        const count = exams ? exams.length : Math.max(0, Math.min(of, Number(r.count) || 0));
        return { topic: str(r.topic, 200), count, of, example: str(r.example, 600), ...(exams ? { exams } : {}) };
      })
      .filter(r => r.topic && r.of >= 2 && r.count >= 2)
      .filter((r, i, all) => all.findIndex(x => x.topic === r.topic) === i);   // (the AI may name one twice)
    const old = await CourseProfile.findOne({ userId: req.userId, course });
    // Nothing valid: the old analysis stays (an empty one would wipe the map).
    if (!recurring.length) return res.json({ success: false, kept: !!old, topics: old ? old.recurring.length : 0 });
    // A full exam built on a few of the files never replaces an analysis of
    // more of them - only the "Analyze" button does (replace: true).
    if (old && req.body.replace !== true && (old.pastExams || []).length > pastExams.length) {
      return res.json({ success: false, kept: true, topics: old.recurring.length });
    }
    const keep = new Set(recurring.map(r => r.topic));
    const had = new Set((old ? old.recurring : []).map(r => r.topic));   // (before doc - the same object - changes)
    const doc = old || new CourseProfile({ userId: req.userId, course });
    doc.recurring = recurring;
    doc.pastExams = pastExams;
    doc.analyzedAt = new Date();
    doc.links = (old ? old.links : []).filter(l => keep.has(l.topic));
    // New topics: every skill is offered again (a big course's, over rounds) -
    // not only the ones that came after the last link.
    if (recurring.some(r => !had.has(r.topic))) doc.linkedSkills = [];
    await doc.save();
    res.json({ success: true, topics: recurring.length });
  })
);

// PUT /api/exam-map/links   { course, topics, links: [{ topic, skills }], skills } - the
// AI's link, kept only where it names real topics and real skills of the course.
// skills: the ones the call was given - their old links are replaced; the
// course's other skills (a big course's, beyond one call) keep theirs.
// topics: the ones the call was given - a new analysis since then refuses it.
router.put(
  '/links',
  asyncHandler(async (req, res) => {
    const course = str(req.body.course, 100);
    const profile = await CourseProfile.findOne({ userId: req.userId, course });
    if (!profile) throw new ApiError(404, 'No exam profile for this course yet.');
    const now = new Set(profile.recurring.map(r => r.topic));
    if (Array.isArray(req.body.topics)) {
      const given = new Set(req.body.topics.map(tp => str(tp, 200)));
      if (given.size !== now.size || [...now].some(tp => !given.has(tp))) return res.status(409).json({ success: false, stale: true });
    }
    const items = await courseItems(req.userId, course);
    const real = new Set(courseSkills(items, Infinity));
    const asked = new Set((Array.isArray(req.body.skills) ? req.body.skills : []).map(s => str(s, 120)).filter(s => real.has(s)));
    const topics = new Set(profile.recurring.map(r => r.topic));
    const sent = Array.isArray(req.body.links) ? req.body.links : [];
    const byTopic = new Map();
    for (const l of sent) {
      const topic = str(l && l.topic, 200);
      if (!topics.has(topic)) continue;
      const skills = (Array.isArray(l.skills) ? l.skills : []).map(s => str(s, 120)).filter(s => real.has(s));
      byTopic.set(topic, [...new Set([...(byTopic.get(topic) || []), ...skills])]);
    }
    const before = new Map((profile.links || []).map(l => [l.topic, (l.skills || []).filter(s => real.has(s) && !asked.has(s))]));
    profile.links = [...topics].map(topic => ({ topic, skills: [...new Set([...(byTopic.get(topic) || []), ...(before.get(topic) || [])])] }));
    profile.linkedSkills = [...new Set([...(profile.linkedSkills || []).filter(s => real.has(s)), ...asked])];
    profile.linkedAt = new Date();
    await profile.save();
    res.json({ success: true, topics: topicStats(profile.toObject(), items) });
  })
);

module.exports = router;
