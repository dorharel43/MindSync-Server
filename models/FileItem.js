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
    },
    content: {
      type: String,
      default: '',
    },
    // Stored as the folder's *name* (matches the client: uploadFolderSelect.value).
    // "No Folder" is the unfiled bucket.
    folder: {
      type: String,
      default: 'No Folder',
      trim: true,
    },
    // Absolute path to the file as originally chosen, kept so a PDF can be
    // re-rendered into page images for vision reading. Extracted text is a
    // lossy copy; the original is the only thing that isn't. May go stale if
    // the user moves the file, so every use must tolerate it being missing.
    sourcePath: {
      type: String,
      default: '',
      trim: true,
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

module.exports = mongoose.model('FileItem', fileItemSchema);
