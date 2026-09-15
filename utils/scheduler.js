// Spaced repetition scheduling, adapted from SM-2.
//
// Two deliberate departures from textbook SM-2:
//
// 1. The grade is derived from BOTH the outcome and the stated confidence.
//    Getting something right while guessing is not the same as getting it
//    right while certain - the first is luck and should come back soon.
//
// 2. 'practice' items are scheduled more conservatively. A maths skill you
//    solved once is not learned; procedural skills need more contact.

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

function schedule(item, outcome, confidence) {
    const grade = gradeFrom(outcome, confidence);

    let { interval = 0, ease = 2.5, repetitions = 0, lapses = 0 } = item;
    const isPractice = item.mode === 'practice';

    if (grade < 3) {
        repetitions = 0;
        lapses += 1;
        interval = grade === 0 ? 0 : 1;   // 0 = same session
    } else {
        repetitions += 1;

        if (repetitions === 1) {
            interval = 1;
        } else if (repetitions === 2) {
            interval = isPractice ? 3 : 6;
        } else {
            interval = Math.round(interval * ease);
        }

        if (isPractice) interval = Math.max(1, Math.round(interval * 0.7));
    }

    ease = ease + (0.1 - (5 - grade) * (0.08 + (5 - grade) * 0.02));
    ease = Math.max(1.3, Math.min(3.0, ease));

    // An item that keeps being forgotten shouldn't keep getting long gaps.
    if (lapses >= 4) interval = Math.min(interval, 7);

    interval = Math.min(interval, 120);

    const dueDate = new Date();
    if (interval === 0) {
        dueDate.setMinutes(dueDate.getMinutes() + 10);  // same-session retry
    } else {
        dueDate.setDate(dueDate.getDate() + interval);
        dueDate.setHours(4, 0, 0, 0);
    }

    return { interval, ease, repetitions, lapses, dueDate, grade };
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