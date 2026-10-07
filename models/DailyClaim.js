// One daily exam question a day (3/10): a claim per user and day, its _id
// "<userId>:<YYYY-MM-DD>". The _id is unique in every Mongo-compatible
// database, so two saves at the same moment can't both pass - the second
// gets a duplicate key and a 409. Old claims are removed as new ones come.
const mongoose = require('mongoose');

const dailyClaimSchema = new mongoose.Schema({
    _id: { type: String, maxlength: 60 },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    day: { type: String, maxlength: 10, required: true }
}, { timestamps: true });

module.exports = mongoose.model('DailyClaim', dailyClaimSchema);
