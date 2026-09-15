const express = require('express');
const router = express.Router();
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');

// GET /api/folders
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const folders = await Folder.find().sort({ name: 1 });
    res.json(folders);
  })
);

// POST /api/folders - create
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    const folder = await Folder.create({ name });
    res.status(201).json(folder);
  })
);

// PUT /api/folders/:id - rename (cascades to files that reference it by name)
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const oldFolder = await Folder.findById(req.params.id);
    if (!oldFolder) throw new ApiError(404, 'Folder not found');
    const oldName = oldFolder.name;

    const folder = await Folder.findByIdAndUpdate(
      req.params.id,
      { name: req.body.name },
      { new: true, runValidators: true }
    );

    if (oldName !== folder.name) {
      await FileItem.updateMany({ folder: oldName }, { folder: folder.name });
    }

    res.json(folder);
  })
);

// DELETE /api/folders/:id - moves its files to "No Folder" instead of
// orphaning them (the bug the original app had).
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const folder = await Folder.findByIdAndDelete(req.params.id);
    if (!folder) throw new ApiError(404, 'Folder not found');

    const { modifiedCount } = await FileItem.updateMany({ folder: folder.name }, { folder: 'No Folder' });

    res.json({ success: true, deletedId: req.params.id, filesMoved: modifiedCount });
  })
);

module.exports = router;
