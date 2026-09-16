const express = require('express');
const router = express.Router();
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/folders
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const folders = await Folder.find({ userId: req.userId }).sort({ name: 1 });
    res.json(folders);
  })
);

// POST /api/folders - create
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    const folder = await Folder.create({ userId: req.userId, name });
    res.status(201).json(folder);
  })
);

// PUT /api/folders/:id - rename (cascades to files that reference it by name)
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const oldFolder = await Folder.findOne({ _id: req.params.id, userId: req.userId });
    if (!oldFolder) throw new ApiError(404, 'Folder not found');
    const oldName = oldFolder.name;

    const folder = await Folder.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { name: req.body.name },
      { new: true, runValidators: true }
    );

    if (oldName !== folder.name) {
      // Scoped by userId too - otherwise renaming your own folder could
      // silently reassign a different user's files that happen to share the
      // old folder name.
      await FileItem.updateMany({ userId: req.userId, folder: oldName }, { folder: folder.name });
    }

    res.json(folder);
  })
);

// DELETE /api/folders/:id - moves its files to "No Folder" instead of
// orphaning them (the bug the original app had).
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const folder = await Folder.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!folder) throw new ApiError(404, 'Folder not found');

    const { modifiedCount } = await FileItem.updateMany(
      { userId: req.userId, folder: folder.name },
      { folder: 'No Folder' }
    );

    res.json({ success: true, deletedId: req.params.id, filesMoved: modifiedCount });
  })
);

module.exports = router;