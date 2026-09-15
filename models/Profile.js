const mongoose = require('mongoose');

// Singleton: single-user desktop app -> exactly one profile document.
// See utils/singleton.js for the get/update helpers.
const profileSchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true, maxlength: 120 },
    degree: { type: String, default: '', trim: true, maxlength: 120 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Profile', profileSchema);
