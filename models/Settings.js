const mongoose = require('mongoose');

// Singleton: app-wide settings. The actual `tasklist`/`taskkill` polling
// stays in the Electron main process (OS-level concern) - only the *data*
// of which apps to block lives here.
const settingsSchema = new mongoose.Schema(
  {
    blockedApps: {
      type: [String],
      default: ['steam.exe', 'Battle.net.exe', 'EpicGamesLauncher.exe', 'LeagueClient.exe', 'Discord.exe'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
