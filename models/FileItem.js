const mongoose = require('mongoose');

const fileItemSchema = new mongoose.Schema(
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
      required: [true, 'File name is required'],
      trim: true,
      maxlength: [300, 'File name is too long'],
    },
    // Capped (30/9): the text extracted from a big PDF is well under this;
    // without a cap one user could fill the shared database.
    content: {
      type: String,
      default: '',
      maxlength: [1500000, 'This file\'s text is too long to store.'],
    },
    // Stored as the folder's *name* (matches the client: uploadFolderSelect.value).
    // "No Folder" is the unfiled bucket.
    folder: {
      type: String,
      default: 'No Folder',
      trim: true,
      maxlength: 120,
    },
    // Absolute path to the file as originally chosen, kept so a PDF can be
    // re-rendered into page images for vision reading. Extracted text is a
    // lossy copy; the original is the only thing that isn't. May go stale if
    // the user moves the file, so every use must tolerate it being missing.
    sourcePath: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    // The AI summary of this file, saved so it survives closing the window.
    // It used to live only in the modal and was lost the moment it closed,
    // which meant paying for (and waiting on) the same summary every time.
    summary: {
      type: String,
      default: '',
      maxlength: [60000, 'Summary is too long'],
    },
    summaryUpdatedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

fileItemSchema.index({ userId: 1, folder: 1 });

// The course (8/10, utils/courses.js): the folder's id next to its name, so a
// rename reaches this too. null = no course; missing = from before (migrated).
fileItemSchema.add({ courseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Folder', default: undefined } });
fileItemSchema.index({ userId: 1, courseId: 1 });
// What the file is (8/10) - the student picks at upload; the name guesses.
fileItemSchema.add({ role: { type: String, enum: ['material', 'past_exam', 'syllabus'], default: undefined } });

module.exports = mongoose.model('FileItem', fileItemSchema);
