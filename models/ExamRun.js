// A mock exam (30/9): one course, typed answers under exam conditions, all
// checked at the end. The latest score is the course's evidence-based
// "if the exam were today" - a number made of real answers, not a feeling.
const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
    itemId: { type: mongoose.Schema.Types.ObjectId },
    question: { type: String, maxlength: 600 },          // a short copy, for the history
    topic: { type: String, maxlength: 120, default: '' },
    confidence: { type: String, enum: ['sure', 'think_so', 'guessing', 'none'], default: 'none' },
    // correct / partial / wrong; 'blank' = skipped or out of time;
    // 'unchecked' = the AI couldn't check it (not in the score)
    verdict: { type: String, enum: ['correct', 'partial', 'wrong', 'blank', 'unchecked'], default: 'unchecked' }
}, { _id: false });

const examRunSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: String, required: true, trim: true, maxlength: 100 },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: Date.now },
    limitSec: { type: Number, default: 0 },              // 0 = no time limit
    usedSec: { type: Number, default: 0 },
    answers: { type: [answerSchema], default: [] },
    checked: { type: Number, default: 0 },               // answers in the score
    score: { type: Number, min: 0, max: 100, default: 0 },
    margin: { type: Number, min: 0, max: 100, default: 0 }
});

examRunSchema.index({ userId: 1, course: 1, finishedAt: -1 });

module.exports = mongoose.model('ExamRun', examRunSchema);
