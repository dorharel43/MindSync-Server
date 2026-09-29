const mongoose = require('mongoose');

// One row per user per (Israel) day they used the app - written by
// requireAuth, at most once a day per user. It's what the owner's beta page
// (/admin) counts to answer "do people come back?" (30/9).
const activeDaySchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true }   // 'YYYY-MM-DD'
});

activeDaySchema.index({ userId: 1, day: 1 }, { unique: true });
activeDaySchema.index({ day: 1 });

module.exports = mongoose.model('ActiveDay', activeDaySchema);
