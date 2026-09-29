const mongoose = require('mongoose');

// One user's connection to their Google Calendar (web version).
//
// refreshToken is what lets the server add events for this user later
// without asking again - so it is stored ENCRYPTED (rpc/google.js,
// AES-256-GCM with GOOGLE_TOKEN_KEY), never in plain text. A database leak
// alone doesn't give anyone access to people's calendars.
//
// calendarId is the "MindSync" calendar the app created in their account:
// events go there, not into their main calendar, so they can hide or delete
// all of MindSync's events in one click in Google Calendar.
const googleLinkSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    refreshTokenEnc: { type: String, required: true },
    calendarId: { type: String, default: null },
    email: { type: String, default: '' },
    scope: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('GoogleLink', googleLinkSchema);
