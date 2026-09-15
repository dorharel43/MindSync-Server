const mongoose = require('mongoose');

const folderSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Folder name is required'],
      trim: true,
      unique: true,
      maxlength: [120, 'Folder name is too long (max 120 characters)'],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Folder', folderSchema);
