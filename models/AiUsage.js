const mongoose = require('mongoose');

// How much AI one user used on one day (Israel calendar day). The web
// version pays for AI with the server's key, so each user gets a daily
// allowance (rpc/aiUsage.js). "heavy" = reading a whole file (questions,
// summary, syllabus); "light" = short text jobs (classifying a task,
// reading a date).
const aiUsageSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },          // 'YYYY-MM-DD'
    heavy: { type: Number, default: 0 },
    light: { type: Number, default: 0 }
}, { timestamps: true });

aiUsageSchema.index({ userId: 1, day: 1 }, { unique: true });

module.exports = mongoose.model('AiUsage', aiUsageSchema);
