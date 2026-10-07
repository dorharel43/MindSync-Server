// A course's exam profile (3/10, "what repeats in the exam"): what the
// course's past exams keep asking (from the app's past-exam analysis - the
// same one a full exam is built on), and which of the student's practice
// skills (StudyItem.skillTag) each repeating topic covers - linked once by a
// light AI call, again only when enough new skills arrive. Joined with the
// student's answers, it says where an hour of practice pays most.
const mongoose = require('mongoose');

const recurringSchema = new mongoose.Schema({
    topic: { type: String, maxlength: 200 },
    count: { type: Number, min: 0, max: 50 },
    of: { type: Number, min: 0, max: 50 },
    example: { type: String, maxlength: 600, default: '' }
}, { _id: false });

const linkSchema = new mongoose.Schema({
    topic: { type: String, maxlength: 200 },
    skills: { type: [{ type: String, maxlength: 120 }], default: [] }
}, { _id: false });

const courseProfileSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    course: { type: String, required: true, trim: true, maxlength: 100 },
    recurring: { type: [recurringSchema], default: [] },
    pastExams: { type: [{ type: String, maxlength: 300 }], default: [] },
    analyzedAt: { type: Date },
    links: { type: [linkSchema], default: [] },
    // the course's skills the last link was made with - new ones (enough of them) relink
    linkedSkills: { type: [{ type: String, maxlength: 120 }], default: [] },
    linkedAt: { type: Date }
}, { timestamps: true });
courseProfileSchema.index({ userId: 1, course: 1 }, { unique: true });

module.exports = mongoose.model('CourseProfile', courseProfileSchema);
