// Spaced repetition scheduling, adapted from SM-2.
//
// Three deliberate departures from textbook SM-2:
//
// 1. The grade is derived from BOTH the outcome and the stated confidence.
//    Getting something right while guessing is not the same as getting it
//    right while certain - the first is luck and should come back soon.
//
// 2. 'practice' items are scheduled more conservatively. A maths skill you
//    solved once is not learned; procedural skills need more contact.
//
// 3. Exams. SM-2 has no deadline: an item answered right three times comes
//    back in 15 days, then 37. With the course's exam in three weeks it would
//    never be seen again before the exam. When the caller passes
//    daysUntilExam, the next review is never later than the day before the
//    exam (see utils/examSchedule.js for how the exam is found).

const { todayIso } = require('./examSchedule');

const OUTCOME_CORRECT = {
    got_it: true, partial: false, missed: false,
    solved: true, stuck: false, wrong: false
};

// Maps (outcome, confidence) onto a 0-5 quality grade.
function gradeFrom(outcome, confidence) {
    const correct = OUTCOME_CORRECT[outcome] === true;
    const partial = outcome === 'partial' || outcome === 'stuck';

    if (correct) {
        if (confidence === 'sure') return 5;        // knew it, and knew they knew it
        if (confidence === 'think_so') return 4;
        return 3;                                   // right while guessing - shaky
    }

    if (partial) return 2;

    // Being wrong while certain is the worst case: a confidently held
    // misconception, which needs to come back fast.
    return confidence === 'sure' ? 0 : 1;
}

// options.daysUntilExam: whole days from today to the course's next exam
// (0 = today), or null/undefined when there is none. options.examDate: that
// exam's date (YYYY-MM-DD).
function schedule(item, outcome, confidence, options = {}) {
    const grade = gradeFrom(outcome, confidence);

    let { interval = 0, ease = 2.5, repetitions = 0, lapses = 0 } = item;
    const isPractice = item.mode === 'practice';

    // Right while guessing is luck, not knowledge (30/9): no evidence either
    // way. Back tomorrow to check; nothing advances (no repetition, no ease
    // change), so a string of lucky guesses can't push it out to weeks.
    const luckyGuess = confidence === 'guessing' && OUTCOME_CORRECT[outcome] === true;

    if (luckyGuess) {
        interval = 1;
    } else if (grade < 3) {
        repetitions = 0;
        lapses += 1;
        interval = grade === 0 ? 0 : 1;   // 0 = same session
    } else {
        repetitions += 1;

        const previous = interval;
        if (repetitions === 1) {
            interval = 1;
        } else if (repetitions === 2) {
            // Practice (procedural skills) comes back sooner than a fact.
            interval = isPractice ? 2 : 6;
        } else {
            // Practice used to take x0.7 here on every review - on top of an
            // interval already reduced the same way, so it compounded: a hard
            // exercise solved eight times in a row stayed at 2 days forever.
            // The previous interval already carries that caution.
            interval = Math.round(previous * (isPractice ? Math.max(1.3, ease * 0.8) : ease));
        }
        // A success never brings a question back sooner than last time.
        if (repetitions > 1) interval = Math.max(interval, previous + 1);
    }

    if (!luckyGuess) ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
    ease = Math.max(1.3, Math.min(3.0, ease));

    // An item that keeps being forgotten shouldn't keep getting long gaps.
    if (lapses >= 4) interval = Math.min(interval, 7);

    interval = Math.min(interval, 120);

    // Not past the exam: at the latest, the day before it. With the exam
    // today or tomorrow there's nothing to protect - the normal interval
    // stands (it lands after the exam, where it belongs).
    let cappedForExam = false;
    const daysUntilExam = options.daysUntilExam;
    if (Number.isInteger(daysUntilExam) && daysUntilExam >= 2 && interval > daysUntilExam - 1) {
        interval = daysUntilExam - 1;
        cappedForExam = true;
    }

    let dueDate = new Date();
    if (cappedForExam && /^\d{4}-\d{2}-\d{2}$/.test(options.examDate || '')) {
        // Exactly the day before the exam, from the exam's own calendar
        // date - not "now + N days", which is off by one between midnight
        // and 03:00 Israel time (the server runs in UTC).
        const [y, m, d] = options.examDate.split('-').map(Number);
        dueDate = new Date(Date.UTC(y, m - 1, d - 1, 4, 0, 0));
    } else if (interval === 0) {
        dueDate.setMinutes(dueDate.getMinutes() + 10);  // same-session retry
    } else {
        // N calendar days from TODAY IN ISRAEL, at 07:00 there. It was the
        // server's (UTC) date: a review at 00:30 Israel time is still
        // "yesterday" in UTC, so "tomorrow" came back the same morning.
        const [y, m, d] = todayIso(options.now || new Date()).split('-').map(Number);
        dueDate = new Date(Date.UTC(y, m - 1, d + interval, 4, 0, 0));
    }

    return { interval, ease, repetitions, lapses, dueDate, grade, cappedForExam };
}

// Calibration: how well does stated confidence predict actual correctness?
function calibrationReport(reviews) {
    const buckets = {
        sure: { total: 0, correct: 0 },
        think_so: { total: 0, correct: 0 },
        guessing: { total: 0, correct: 0 }
    };

    reviews.forEach(r => {
        const b = buckets[r.confidence];
        if (!b) return;
        b.total += 1;
        if (r.wasCorrect) b.correct += 1;
    });

    const report = {};
    Object.entries(buckets).forEach(([key, b]) => {
        report[key] = {
            total: b.total,
            correct: b.correct,
            accuracy: b.total > 0 ? Math.round((b.correct / b.total) * 100) : null
        };
    });

    report.overconfidenceGap =
        report.sure.accuracy !== null ? Math.max(0, 95 - report.sure.accuracy) : null;

    return report;
}

module.exports = { schedule, gradeFrom, calibrationReport, OUTCOME_CORRECT };