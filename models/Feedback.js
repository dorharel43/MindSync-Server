const mongoose = require('mongoose');

// "Send feedback" from the web version's Settings. Read them in MongoDB Atlas
// (collection: feedbacks).
const feedbackSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, required: true, trim: true, maxlength: 4000 },
    userAgent: { type: String, default: '', maxlength: 400 },
    page: { type: String, default: '', maxlength: 400 }
}, { timestamps: true });

module.exports = mongoose.model('Feedback', feedbackSchema);
