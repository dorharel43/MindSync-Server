// One sitting of a full exam (1/10): the student's answers, then the grade
// per part (points out of the part's points, with a reason) and the total.
const mongoose = require('mongoose');

const answerSchema = new mongoose.Schema({
    q: { type: Number, min: 0, max: 60 },          // question index
    p: { type: Number, min: 0, max: 60 },          // part index
    choice: { type: String, maxlength: 20, default: '' },
    text: { type: String, maxlength: 20000, default: '' },
    // graded
    points: { type: Number, min: 0, max: 100, default: 0 },
    max: { type: Number, min: 0, max: 100, default: 0 },
    feedback: { type: String, maxlength: 3000, default: '' },
    // 'graded' | 'blank' | 'unchecked' (the AI couldn't check it - left out of the score) | 'not_chosen'
    status: { type: String, enum: ['graded', 'blank', 'unchecked', 'not_chosen'], default: 'graded' }
}, { _id: false });

const fullExamRunSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    examId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    course: { type: String, trim: true, maxlength: 100, default: '' },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: Date.now },
    limitSec: { type: Number, min: 0, default: 0 },
    usedSec: { type: Number, min: 0, default: 0 },
    answers: { type: [answerSchema], default: [] },
    score: { type: Number, min: 0, default: 0 },         // points
    max: { type: Number, min: 0, default: 0 },           // points that were graded
    percent: { type: Number, min: 0, max: 100, default: 0 },
    weakTopics: { type: [{ type: String, maxlength: 120 }], default: [] },
    clientRunId: { type: String, maxlength: 40, required: true }
});

fullExamRunSchema.index({ userId: 1, examId: 1, finishedAt: -1 });
// A sitting sent twice (a retry) is saved once.
fullExamRunSchema.index({ userId: 1, clientRunId: 1 }, { unique: true });

module.exports = mongoose.model('FullExamRun', fullExamRunSchema);
