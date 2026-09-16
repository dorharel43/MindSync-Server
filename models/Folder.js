const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema(
  {
    // AUTH: see Task.js for the reasoning.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    name: {
      type: String,
      required: [true, 'Folder name is required'],
      trim: true,
      // BUG FIX: this used to be `unique: true` on name alone, which is a
      // single-field unique index across ALL users - the second person to
      // ever create a folder called "Algebra" would get a 500 from Mongo's
      // duplicate-key error. Uniqueness has to be scoped per user; see the
      // compound index below, which replaces this.
      maxlength: [120, 'Folder name is too long (max 120 characters)'],
    },
  },
  { timestamps: true }
);

// Folder names only need to be unique within one person's own folders.
folderSchema.index({ userId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Folder', folderSchema);