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
      skills: profile ? courseSkills(items) : []
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
    // (a count over its own "of" contradicts itself - dropped, not repaired)
    const recurring = (Array.isArray(req.body.recurring) ? req.body.recurring : []).slice(0, 12)
      .filter(r => r && (Number(r.count) || 0) <= (Number(r.of) || 0))
      .map(r => {
        const of = Math.max(0, Math.min(files, Number(r.of) || 0));
        return { topic: str(r.topic, 200), count: Math.max(0, Math.min(of, Number(r.count) || 0)), of, example: str(r.example, 600) };
      })
      .filter(r => r.topic && r.of >= 2 && r.count >= 2);
    const old = await CourseProfile.findOne({ userId: req.userId, course });
    const keep = new Set(recurring.map(r => r.topic));
    const doc = old || new CourseProfile({ userId: req.userId, course });
    doc.recurring = recurring;
    doc.pastExams = pastExams;
    doc.analyzedAt = new Date();
    doc.links = (old ? old.links : []).filter(l => keep.has(l.topic));
    await doc.save();
    res.json({ success: true, topics: recurring.length });
  })
);

// PUT /api/exam-map/links   { course, links: [{ topic, skills }], skills } - the
// AI's link, kept only where it names real topics and real skills of the course.
router.put(
  '/links',
  asyncHandler(async (req, res) => {
    const course = str(req.body.course, 100);
    const profile = await CourseProfile.findOne({ userId: req.userId, course });
    if (!profile) throw new ApiError(404, 'No exam profile for this course yet.');
    const items = await courseItems(req.userId, course);
    const real = new Set(courseSkills(items, 1000));
    const topics = new Set(profile.recurring.map(r => r.topic));
    const sent = Array.isArray(req.body.links) ? req.body.links : [];
    const byTopic = new Map();
    for (const l of sent) {
      const topic = str(l && l.topic, 200);
      if (!topics.has(topic)) continue;
      const skills = (Array.isArray(l.skills) ? l.skills : []).map(s => str(s, 120)).filter(s => real.has(s));
      byTopic.set(topic, [...new Set([...(byTopic.get(topic) || []), ...skills])].slice(0, 40));
    }
    profile.links = [...topics].map(topic => ({ topic, skills: byTopic.get(topic) || [] }));
    profile.linkedSkills = (Array.isArray(req.body.skills) ? req.body.skills : []).map(s => str(s, 120)).filter(s => real.has(s)).slice(0, 200);
    profile.linkedAt = new Date();
    await profile.save();
    res.json({ success: true, topics: topicStats(profile.toObject(), items) });
  })
);

module.exports = router;
