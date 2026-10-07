// Questions answered today (3/10) - the daily goal's count, and the daily
// exam question's "after 5 answers today". On the app's clock (Israel - like
// the planner's "today"). No streaks: each day starts again from 0.
const StudyItem = require('../models/StudyItem');
const ExamRun = require('../models/ExamRun');
const FullExamRun = require('../models/FullExamRun');
const { APP_TIME_ZONE } = require('./examSchedule');

// When today began on the app's clock.
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

// In practice, in mock exams and in full exams. Nothing is counted twice:
//  - a mock exam saves its checked answers as reviews too (POST
//    /api/study/exam/runs), so they come with the reviews - except its blank
//    ones (skipped or out of time: marked examBlank), which don't count, as a
//    blank part of a full exam doesn't; its unchecked ones (no review saved)
//    are added from the run, as a full exam's unchecked written parts count;
//  - a full exam saves no reviews: each part written, chosen, "I don't know"
//    or from a photo counts.
async function countAnsweredToday(userId, since = startOfAppDay()) {
  const [items, mocks, fulls] = await Promise.all([
    StudyItem.find({ userId, 'reviews.reviewedAt': { $gte: since } }).select('reviews.reviewedAt reviews.examBlank').lean(),
    ExamRun.find({ userId, finishedAt: { $gte: since } }).select('answers.verdict').lean(),
    FullExamRun.find({ userId, finishedAt: { $gte: since } }).select('answers').lean()
  ]);
  let answered = 0;
  for (const i of items) answered += (i.reviews || []).filter(r => !r.examBlank && r.reviewedAt && new Date(r.reviewedAt) >= since).length;
  for (const r of mocks) answered += (r.answers || []).filter(a => a.verdict === 'unchecked').length;
  for (const r of fulls) {
    answered += (r.answers || []).filter(a => a.status !== 'not_chosen'
      && (String(a.text || '').trim() || a.choice || a.dontKnow || a.fromPhoto)).length;
  }
  return answered;
}

module.exports = { startOfAppDay, countAnsweredToday };
