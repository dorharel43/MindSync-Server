// Exam-aware studying.
//
// Plain spaced repetition (SM-2) is built for learning with no deadline: a
// question you answered right three times comes back in 15 days, then in 37.
// A student has an exam on a date. With the exam in three weeks, that
// question would simply never come back before it. So:
//
//   1. A question's next review is never scheduled past its course's next
//      exam (scheduler.js, via daysUntilExam).
//   2. Questions already scheduled past the exam (from before the exam was
//      added, or from before this code) are pulled forward to the day before
//      it - computed here, nothing stored.
//   3. The course with the nearest exam comes first in a session.
//   4. New questions are introduced at a pace that finishes the course before
//      the exam, instead of all 40 from a file landing as "due" at once.
//
// A course is linked to an exam by name: the study item's category
// ("סטטיסטיקה") against the exam event's title ("בוחן אמצע - מבוא
// לסטטיסטיקה"). Exam events come from the Planner - added by hand or by
// "Exams & deadlines" in Materials.

// The app's users are in Israel, and event dates are local calendar dates
// (YYYY-MM-DD). The server runs in UTC, so "today" is computed in Israel time
// - otherwise between 00:00 and 03:00 Israel time "today" would be yesterday.
const APP_TIME_ZONE = 'Asia/Jerusalem';

function todayIso(now = new Date(), timeZone = APP_TIME_ZONE) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(now).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
}

// Whole days from one YYYY-MM-DD to another (UTC arithmetic on dates only,
// so daylight saving can't make it 0.96 of a day).
function daysBetween(fromIso, toIso) {
    const [y1, m1, d1] = fromIso.split('-').map(Number);
    const [y2, m2, d2] = toIso.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

// Words that don't identify a course ("מבוא לסטטיסטיקה" is about statistics).
const GENERIC_WORDS = new Set([
    'מבוא', 'יסודות', 'קורס', 'עקרונות', 'נושאים', 'מתקדם', 'מתקדמים',
    'intro', 'introduction', 'to', 'of', 'the', 'and', 'in', 'course', 'fundamentals', 'basics', 'advanced'
]);
const HEBREW_PREFIX = /^[בלהמושכ]/;

function normalize(s) {
    return String(s || '').toLowerCase()
        // Quote marks INSIDE a word are part of it: חדו"א, ג'אווה -> חדוא, גאווה
        .replace(/(\p{L})["'`׳״](?=\p{L})/gu, '$1')
        // A dot or slash between digits is a number or date (12.2, 1/2): keep
        .replace(/(\d)[./](?=\d)/g, '$1\u2024')
        .replace(/["'`׳״.,:;!?()\[\]{}]/g, ' ')
        .replace(/[-־–—_/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Course numbering: "2", "II", "ב'" (after normalize: "ב"). These must match
// a title word EXACTLY - "אלגברה לינארית 2" is not the exam of "... 1".
const ROMAN = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi']);
const isMarker = (w) => /^\d+$/.test(w) || ROMAN.has(w) || /^[\u05d0-\u05ea]$/.test(w) || /^[a-z]$/.test(w);

// A title word stripped of up to two Hebrew prefix letters ("ולסטטיסטיקה").
function titleForms(word) {
    const forms = [word];
    if (/^[\u05d0-\u05ea]{4,}$/.test(word)) {
        if (HEBREW_PREFIX.test(word)) forms.push(word.slice(1));
        if (word.length > 4 && HEBREW_PREFIX.test(word) && HEBREW_PREFIX.test(word.slice(1))) forms.push(word.slice(2));
    }
    return forms;
}

// Does this exam title belong to this course? Every meaningful word of the
// course name must be a WORD of the title (whole words - "Data" is not in
// "Database"), allowing Hebrew prefixes on either side ("סטטיסטיקה" /
// "בסטטיסטיקה" / "לסטטיסטיקה"). ALL words, not any: "מבני נתונים" must not
// match an exam in "מסדי נתונים" just because of "נתונים". Numbers and
// letters that number a course ("2", "II", "ב'") must be there exactly.
function examMatchesCourse(examTitle, course) {
    const titleWords = new Set();
    for (const w of normalize(examTitle).split(' ')) if (w) titleForms(w).forEach(f => titleWords.add(f));
    const all = normalize(course).split(' ').filter(Boolean);
    let words = all.filter(w => isMarker(w) || (w.length > 1 && !GENERIC_WORDS.has(w) && !GENERIC_WORDS.has(w.length > 3 ? w.replace(HEBREW_PREFIX, '') : w)));
    // Only generic words ("מבוא"): then those have to do.
    if (!words.some(w => !isMarker(w))) words = all;
    if (!words.length) return false;
    return words.every((w) => {
        if (isMarker(w)) return titleWords.has(w);
        const bare = w.length > 3 ? w.replace(HEBREW_PREFIX, '') : w;
        return titleWords.has(w) || titleWords.has(bare);
    });
}

// course -> its NEXT exam { title, date, daysLeft } (today counts; a past
// exam doesn't). Exams without a date (weekly events) are ignored.
function nextExamByCourse(courses, exams, today) {
    const upcoming = (exams || [])
        .filter(e => e && e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= today)
        .sort((a, b) => a.date.localeCompare(b.date));
    const result = {};
    for (const course of courses) {
        const hit = upcoming.find(e => examMatchesCourse(e.title, course));
        if (hit) result[course] = { title: hit.title, date: hit.date, daysLeft: daysBetween(today, hit.date) };
    }
    return result;
}

const courseOf = (item) => (item.category || '').trim() || 'Uncategorized';
const isNew = (item) => !item.reviews || item.reviews.length === 0;

// The day before the exam at 04:00 UTC (07:00 in Israel) - the same hour
// scheduler.js uses for due dates.
function dayBeforeExam(exam) {
    const [y, m, d] = exam.date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1, 4, 0, 0));
}

// When this item should actually be seen: its own due date, but never after
// the day before its course's exam. (Exam today or tomorrow: its own due
// date - pulling everything into the last evening helps nobody.)
function effectiveDue(item, exam) {
    const own = new Date(item.dueDate || 0);
    if (!exam || exam.daysLeft < 2) return own;
    const cap = dayBeforeExam(exam);
    return own > cap ? cap : own;
}

// How many NEW questions a course may introduce per day. With an exam: enough
// to have seen all of them two days before it. Without: a steady 15.
const MAX_PER_SKILL = 3;
const NEW_PER_DAY_DEFAULT = 15;
const NEW_PER_DAY_MIN = 10;
const NEW_PER_DAY_MAX = 40;
function newPerDay(unseenCount, exam) {
    if (!exam) return NEW_PER_DAY_DEFAULT;
    const days = Math.max(1, exam.daysLeft - 2);
    return Math.min(NEW_PER_DAY_MAX, Math.max(NEW_PER_DAY_MIN, Math.ceil(unseenCount / days)));
}

// Builds the practice queue.
//   items: the user's non-suspended study items (with reviews)
//   examsByCourse: from nextExamByCourse
// Returns { queue, byCourse } - byCourse has per-course counts for the stats.
function buildStudyQueue(items, examsByCourse, now = new Date(), { limit = 20, category = null } = {}) {
    const dayAgo = now.getTime() - 24 * 3600 * 1000;
    const groups = {};
    for (const item of items) {
        const course = courseOf(item);
        if (category && course !== category && (item.category || '') !== category) continue;
        (groups[course] = groups[course] || []).push(item);
    }

    const byCourse = {};
    let candidates = [];
    for (const [course, list] of Object.entries(groups)) {
        const exam = examsByCourse[course] || null;
        const unseen = list.filter(isNew).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        // Introduced in the last 24h = first answered in the last 24h.
        const introduced = list.filter(i => !isNew(i) && new Date(i.reviews[0].reviewedAt).getTime() >= dayAgo).length;
        const allowedNew = Math.max(0, newPerDay(unseen.length, exam) - introduced);

        const dueReviews = list.filter(i => !isNew(i) && effectiveDue(i, exam) <= now);
        const newToday = unseen.slice(0, allowedNew);
        byCourse[course] = {
            exam,
            dueReviews: dueReviews.length,
            newToday: newToday.length,
            unseen: unseen.length,
            // pulled forward because of the exam (for the stats / curiosity)
            pulledForward: dueReviews.filter(i => new Date(i.dueDate) > now).length
        };

        const rank = exam ? exam.daysLeft : Number.POSITIVE_INFINITY;
        dueReviews.forEach(i => candidates.push({ item: i, rank, isNew: 0, due: effectiveDue(i, exam).getTime() }));
        newToday.forEach((i, n) => candidates.push({ item: i, rank, isNew: 1, due: n }));
    }

    // Nearest exam first; within a course, questions to review before new
    // ones; the most overdue first.
    candidates.sort((a, b) => a.rank - b.rank || a.isNew - b.isNew || a.due - b.due);

    // Practice items: a few per skill per session (drilling ten near-identical
    // problems teaches the answers, not the skill). Was ONE per skill - but
    // the AI tags a whole worksheet with the same few skills, so a worksheet
    // of 12 exercises said "12 ready" and the session ended after one.
    const perSkill = new Map();
    const queue = [];
    for (const c of candidates) {
        const it = c.item;
        if (it.mode === 'practice' && it.skillTag) {
            const key = `${courseOf(it)}\u0000${it.skillTag}`;
            const n = perSkill.get(key) || 0;
            if (n >= MAX_PER_SKILL) continue;
            perSkill.set(key, n + 1);
        }
        queue.push(it);
    }
    // What a session of each course would really hold - the course rows show
    // this, so "N ready" is what "Practice" then serves.
    for (const it of queue) {
        const b = byCourse[courseOf(it)];
        if (b) b.queued = (b.queued || 0) + 1;
    }
    return { queue: queue.slice(0, limit), total: queue.length, byCourse };
}

module.exports = {
    APP_TIME_ZONE, todayIso, daysBetween, examMatchesCourse, nextExamByCourse,
    effectiveDue, newPerDay, buildStudyQueue
};