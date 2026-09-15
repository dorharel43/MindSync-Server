const mongoose = require('mongoose');

const fileItemSchema = new mongoose.Schema(
  {
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
  },
  { timestamps: true }
);

module.exports = mongoose.model('FileItem', fileItemSchema);
