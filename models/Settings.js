const mongoose = require('mongoose');

// Singleton: app-wide settings. The actual `tasklist`/`taskkill` polling
// stays in the Electron main process (OS-level concern) - only the *data*
// of which apps to block lives here.
const settingsSchema = new mongoose.Schema(
  {
    // BUG FIX (30/9): routes/settings.js looks settings up by userId, but the
    // field wasn't in the schema - with strictQuery on, Mongoose drops the
    // unknown filter, so findOne({ userId }) became findOne({}) and EVERY
    // user shared the first user's blocked-apps list.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: { unique: true, sparse: true } },
    blockedApps: {
      type: [String],
      default: ['steam.exe', 'Battle.net.exe', 'EpicGamesLauncher.exe', 'LeagueClient.exe', 'Discord.exe'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
