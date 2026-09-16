const mongoose = require('mongoose');

// A single review event. Kept as history rather than just a running average,
// because the calibration feature needs to compare what you *predicted* you
// knew against what you *actually* knew, over time.
const reviewSchema = new mongoose.Schema({
    // What the user claimed BEFORE seeing the answer.
    confidence: {
        type: String,
        enum: ['sure', 'think_so', 'guessing'],
        required: true
    },
    // What actually happened AFTER.
    // recall mode:   got_it | partial | missed
    // practice mode: solved  | stuck   | wrong
    outcome: {
        type: String,
        enum: ['got_it', 'partial', 'missed', 'solved', 'stuck', 'wrong'],
        required: true
    },
    // Derived once at review time so calibration queries don't have to
    // re-interpret the outcome vocabulary of each mode.
    wasCorrect: { type: Boolean, required: true },
    reviewedAt: { type: Date, default: Date.now },
    secondsSpent: { type: Number, default: 0 }
}, { _id: false });

const studyItemSchema = new mongoose.Schema({
    // AUTH: see Task.js for the reasoning.
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    // ---- Content ----
    question: {
        type: String,
        required: [true, 'A study item needs a question'],
        trim: true,
        maxlength: [2000, 'Question is too long']
    },
    // For 'practice' items this holds the method/approach, not a numeric
    // answer - the app never grades maths, the student does.
    answer: {
        type: String,
        default: '',
        trim: true,
        maxlength: [4000, 'Answer is too long']
    },

    // ---- Mode ----
    // recall:   knowledge. Retrieve from memory, then self-rate.
    // practice: skill. Solve on paper, then report whether you managed.
    // explain:  understanding. Explain in your own words, compared to source.
    mode: {
        type: String,
        enum: ['recall', 'practice', 'explain'],
        default: 'recall'
    },

    // For practice items, repetition is over the TYPE of problem, not the
    // specific one - seeing the identical integral again just tests whether
    // you remember the answer, which is worthless. Items sharing a skillTag
    // are treated as interchangeable instances of one skill.
    skillTag: {
        type: String,
        default: '',
        trim: true,
        maxlength: 120
    },

    // The student's OWN worked solution, saved the first time they solve a
    // practice item. This is the answer source for problems: the app can't
    // verify maths and a local model inventing a method is worse than
    // silence, but the student's own working is authoritative by definition -
    // and by the second review it's exactly what they need to see.
    // Where the stored answer came from. Shown to the student, because how
    // much to trust an answer depends entirely on who wrote it: a passage
    // lifted from the lecturer's own slides is authoritative, an AI-written
    // solution to an exercise is a best effort that might be wrong.
    // 'imported' is its own source, not a flavour of the others: a card that
    // came from Quizlet, Anki or a NotebookLM export was written by someone
    // else entirely, against material we have never seen. The student needs
    // to know that when deciding how far to trust the answer in front of them.
    solutionSource: {
        type: String,
        enum: ['document', 'ai', 'user', 'imported', 'none'],
        default: 'document'
    },

    mySolution: {
        type: String,
        default: '',
        trim: true,
        maxlength: [4000, 'Solution is too long']
    },

    category: { type: String, default: '', trim: true, maxlength: 100 },
    sourceFile: { type: String, default: '', trim: true },

    // ---- Scheduling state (SM-2 derived) ----
    // Days until the next review. 0 means "not yet scheduled / new".
    interval: { type: Number, default: 0, min: 0 },
    // How easy this item is for THIS user. Higher = longer gaps.
    ease: { type: Number, default: 2.5, min: 1.3, max: 3.0 },
    dueDate: { type: Date, default: Date.now },
    repetitions: { type: Number, default: 0, min: 0 },
    // Times it was known and then forgotten. High lapses = genuinely hard.
    lapses: { type: Number, default: 0, min: 0 },

    reviews: { type: [reviewSchema], default: [] },

    // Suspended items stay in the deck but are never scheduled - for content
    // that turned out to be wrong or irrelevant, without losing its history.
    suspended: { type: Boolean, default: false }
}, {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// Fast lookup of what's due - the single most frequent query in the app.
// userId leads the compound index since every query is scoped to one user
// first and foremost.
studyItemSchema.index({ userId: 1, dueDate: 1, suspended: 1 });
studyItemSchema.index({ userId: 1, category: 1 });

studyItemSchema.virtual('isDue').get(function () {
    return !this.suspended && this.dueDate <= new Date();
});

// A rough "do you actually know this" score from recent history, used to
// surface weak topics. Recent reviews count for more than old ones.
studyItemSchema.virtual('strength').get(function () {
    if (!this.reviews || this.reviews.length === 0) return 0;
    const recent = this.reviews.slice(-5);
    let weighted = 0;
    let totalWeight = 0;
    recent.forEach((r, i) => {
        const weight = i + 1; // later reviews weigh more
        weighted += (r.wasCorrect ? 1 : 0) * weight;
        totalWeight += weight;
    });
    return Math.round((weighted / totalWeight) * 100);
});

module.exports = mongoose.model('StudyItem', studyItemSchema);