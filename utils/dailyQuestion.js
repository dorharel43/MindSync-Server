// The daily exam question (3/10): once a day, after a few answers, one
// exam-level question on the student's weakest topic - written by the app
// (AI) only when the student asks for it, saved as a full exam with one
// question (FullExam.daily), and solved and graded like one.
//
// Which course and topic - worked out from what the student did, no AI:
//   course: the nearest exam (within EXAM_SOON_DAYS) > the lowest recent
//           accuracy (at least MIN_COURSE_REVIEWS answers) > the course
//           practised most lately > any course with files. Only courses with
//           files: the question is written from the course material.
//   topic:  the skill (skillTag) answered worst lately (at least
//           MIN_TOPIC_REVIEWS answers), not the same as the last daily
//           question's when another is about as weak; else the weak topics
//           of the course's last full exam; else '' (the whole course).
const StudyItem = require('../models/StudyItem');
const FileItem = require('../models/FileItem');
const FullExam = require('../models/FullExam');
const FullExamRun = require('../models/FullExamRun');
const CourseProfile = require('../models/CourseProfile');
const { bestTopic } = require('./examMap');

const UNLOCK_AFTER = 5;           // answers today before the question opens
const EXAM_SOON_DAYS = 45;
const MIN_COURSE_REVIEWS = 5;
const MIN_TOPIC_REVIEWS = 2;
const RECENT = 30;                // a course's last answers that count
const RECENT_TOPIC = 8;           // a topic's last answers that count
const KEEP_DAILY = 14;            // daily questions kept per user (and their sittings)

const courseOf = (item) => (item.category || '').trim() || 'Uncategorized';
const lastN = (reviews, n) => reviews.slice().sort((a, b) => new Date(b.reviewedAt) - new Date(a.reviewedAt)).slice(0, n);
const accuracy = (reviews) => reviews.length ? reviews.filter(r => r.wasCorrect).length / reviews.length : null;

async function pickTarget(userId, examsForCourses) {
  const [items, files, lastDaily] = await Promise.all([
    StudyItem.find({ userId, suspended: false }).select('category skillTag reviews.wasCorrect reviews.reviewedAt reviews.examBlank').lean(),
    FileItem.find({ userId }).select('folder').lean(),
    FullExam.findOne({ userId, daily: true }).sort({ createdAt: -1 }).select('course topic').lean()
  ]);
  // ('No Folder' is the files not in any course, 'Uncategorized' the questions - not courses)
  const NOT_A_COURSE = new Set(['', 'No Folder', 'Uncategorized']);
  const withFiles = new Set(files.map(f => String(f.folder || '').trim()).filter(f => !NOT_A_COURSE.has(f)));
  if (!withFiles.size) return null;

  const byCourse = new Map();
  for (const i of items) {
    const c = courseOf(i);
    if (!withFiles.has(c)) continue;
    const e = byCourse.get(c) || { items: [], reviews: [] };
    e.items.push(i);
    e.reviews.push(...(i.reviews || []).filter(r => !r.examBlank && r.reviewedAt));
    byCourse.set(c, e);
  }
  const courses = [...withFiles];
  const exams = await examsForCourses(userId, courses);

  let course = null, why = 'course';
  const soon = courses.filter(c => exams[c] && exams[c].daysLeft <= EXAM_SOON_DAYS)
    .sort((a, b) => exams[a].daysLeft - exams[b].daysLeft);
  if (soon.length) { course = soon[0]; why = 'exam_soon'; }
  if (!course) {
    const scored = [...byCourse.entries()]
      .map(([c, e]) => ({ c, rev: lastN(e.reviews, RECENT) }))
      .filter(x => x.rev.length >= MIN_COURSE_REVIEWS)
      .map(x => ({ ...x, acc: accuracy(x.rev) }))
      .sort((a, b) => a.acc - b.acc);
    // ("your weakest course" only when there is another to compare it with)
    if (scored.length) { course = scored[0].c; why = scored.length > 1 ? 'weakest' : 'recent'; }
  }
  if (!course) {
    const recent = [...byCourse.entries()]
      .map(([c, e]) => ({ c, last: Math.max(0, ...e.reviews.map(r => new Date(r.reviewedAt).getTime())) }))
      .filter(x => x.last > 0)
      .sort((a, b) => b.last - a.last);
    if (recent.length) { course = recent[0].c; why = 'recent'; }
  }
  if (!course) course = courses.sort((a, b) => a.localeCompare(b))[0];

  // The topic: where an hour pays most - a topic the course's past exams keep
  // asking and the student doesn't know yet (utils/examMap.js), when the
  // course has an exam profile; else the weakest skill lately.
  const profile = await CourseProfile.findOne({ userId, course }).lean();
  if (profile) {
    // (any topic - one with no questions yet is exactly what a new question covers)
    const best = bestTopic(profile, (byCourse.get(course) || { items: [] }).items, { practicable: false });
    const repeat = best && lastDaily && lastDaily.course === course && lastDaily.topic === best.topic.slice(0, 120);
    if (best && !repeat) return { course, topic: best.topic, why, accuracy: best.accuracy, exam: exams[course] || null, repeats: { count: best.count, of: best.of } };
  }
  // The weakest skill lately.
  const bySkill = new Map();
  for (const i of (byCourse.get(course) || { items: [] }).items) {
    const tag = String(i.skillTag || '').trim();
    if (!tag) continue;
    const list = bySkill.get(tag) || [];
    list.push(...(i.reviews || []).filter(r => !r.examBlank && r.reviewedAt));
    bySkill.set(tag, list);
  }
  const skills = [...bySkill.entries()]
    .map(([tag, rev]) => ({ tag, rev: lastN(rev, RECENT_TOPIC) }))
    .filter(x => x.rev.length >= MIN_TOPIC_REVIEWS)
    .map(x => ({ tag: x.tag, acc: accuracy(x.rev), wrong: x.rev.filter(r => !r.wasCorrect).length }))
    .filter(x => x.acc < 1)
    .sort((a, b) => a.acc - b.acc || b.wrong - a.wrong);
  let topic = '', accuracyPct = null;
  if (skills.length) {
    let pick = skills[0];
    // Not yesterday's topic again, when another one is about as weak.
    const repeat = lastDaily && lastDaily.course === course && lastDaily.topic === pick.tag;
    if (repeat && skills[1] && skills[1].acc - pick.acc <= 0.15) pick = skills[1];
    topic = pick.tag;
    accuracyPct = Math.round(pick.acc * 100);
  } else {
    // The weak topics of the course's last full exams - not the last daily topic again.
    const runs = await FullExamRun.find({ userId, course, 'weakTopics.0': { $exists: true } }).sort({ finishedAt: -1 }).limit(5).select('weakTopics').lean();
    const last = lastDaily && lastDaily.course === course ? lastDaily.topic : null;
    const found = runs.flatMap(r => r.weakTopics || []).find(tp => tp && tp !== last);
    if (found) topic = String(found).slice(0, 120);
  }
  return { course, topic, why, accuracy: accuracyPct, exam: exams[course] || null };
}

module.exports = { pickTarget, UNLOCK_AFTER, KEEP_DAILY };
