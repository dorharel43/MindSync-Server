// A full exam (1/10): a whole exam paper written by the AI for one course,
// in the structure of the course's past exams when the student uploaded some
// (questions, sub-parts, points, time), with a worked solution and a marking
// scheme for every part - so it can be graded like a lecturer would, with
// partial credit. The runs (a student's answers and the grading) are in
// FullExamRun.
const mongoose = require('mongoose');

const rubricSchema = new mongoose.Schema({
    criterion: { type: String, maxlength: 400 },
    points: { type: Number, min: 0, max: 100 }
}, { _id: false });

const partSchema = new mongoose.Schema({
    label: { type: String, maxlength: 20, default: '' },          // א / ב / ג, or '' for a one-part question
    // mc: pick one option; tf: true/false + a justification; open: free text
    // (a computation, a proof, an explanation); code: code or SQL
    type: { type: String, enum: ['mc', 'tf', 'open', 'code'], default: 'open' },
    text: { type: String, maxlength: 6000, default: '' },
    options: { type: [{ type: String, maxlength: 1000 }], default: [] },
    correct: { type: String, maxlength: 20, default: '' },        // mc: option index "0".."n"; tf: "true"/"false"
    // tf: no points without a justification; mc: "circle and explain" - a
    // wrong choice 0, a right one 30%-100% by the reason
    reasonRequired: { type: Boolean, default: false },
    points: { type: Number, min: 0, max: 100, default: 0 },
    answer: { type: String, maxlength: 12000, default: '' },        // the full worked solution
    rubric: { type: [rubricSchema], default: [] },
    topic: { type: String, maxlength: 120, default: '' },
    // worked out on paper (a computation, formulas, a proof): the student may photograph the answer
    handwritten: { type: Boolean, default: false },
    // 'checked' = a second, independent solution agreed; 'corrected' = it
    // disagreed and the solution was replaced; 'doubtful' = a late check (on a
    // saved exam) found the question itself wrong or unclear; '' = not checked
    check: { type: String, enum: ['checked', 'corrected', 'doubtful', ''], default: '' }
}, { _id: false });

const questionSchema = new mongoose.Schema({
    n: { type: Number, min: 1, max: 60 },
    title: { type: String, maxlength: 200, default: '' },
    stem: { type: String, maxlength: 8000, default: '' },          // shared text / code / data for all parts
    points: { type: Number, min: 0, max: 1000, default: 0 },
    // "answer 1 of 2" inside a question (e.g. prove ONE of two theorems)
    choosePartsCount: { type: Number, min: 0, max: 50, default: 0 },
    // a bonus question (only when the past exams mark one): its points are on
    // top of totalPoints
    bonus: { type: Boolean, default: false },
    parts: { type: [partSchema], default: [] }
}, { _id: false });

const recurringSchema = new mongoose.Schema({
    topic: { type: String, maxlength: 200 },
    count: { type: Number, min: 0, max: 50 },
    of: { type: Number, min: 0, max: 50 },
    example: { type: String, maxlength: 600, default: '' }
}, { _id: false });

const fullExamSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: String, required: true, trim: true, maxlength: 100 },
    title: { type: String, trim: true, maxlength: 200, default: '' },
    // built on the course's past exams, or only on its material
    basis: { type: String, enum: ['past_exams', 'material'], default: 'material' },
    pastExamFiles: { type: [{ type: String, maxlength: 300 }], default: [] },
    durationMin: { type: Number, min: 5, max: 600, default: 120 },
    materials: { type: String, maxlength: 400, default: '' },       // allowed material, as the past exams say
    instructions: { type: String, maxlength: 2000, default: '' },
    totalPoints: { type: Number, min: 0, max: 5000, default: 100 },   // without bonus questions
    bonusPoints: { type: Number, min: 0, max: 5000, default: 0 },
    // the top grade when the points add up to more ("108 points, the grade is
    // at most 100"); 0 = the grade is out of totalPoints
    maxGrade: { type: Number, min: 0, max: 5000, default: 0 },
    // part of the points for "I don't know" (e.g. 0.25), when the past exams say so
    dontKnowShare: { type: Number, min: 0, max: 0.5, default: 0 },
    // the writer marked which parts are worked out on paper (part.handwritten);
    // an older exam: the app guesses from maths in the text
    handwrittenMarked: { type: Boolean, default: false },
    questions: { type: [questionSchema], default: [] },
    recurring: { type: [recurringSchema], default: [] },             // what repeats in the past exams
    language: { type: String, maxlength: 10, default: '' }
}, { timestamps: true });

fullExamSchema.index({ userId: 1, course: 1, createdAt: -1 });

module.exports = mongoose.model('FullExam', fullExamSchema);
