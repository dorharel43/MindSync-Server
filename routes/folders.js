const express = require('express');
const router = express.Router();
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const { renameCourse, removeCourse } = require('../utils/courses');
const asyncHandler = require('../middleware/asyncHandler');
const { assertRoom } = require('../middleware/perUserCap');
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
    await assertRoom(Folder, req.userId);
    const folder = await Folder.create({ userId: req.userId, name });
    res.status(201).json(folder);
  })
);

// PUT /api/folders/:id - rename. A folder is a course (8/10): the rename
// reaches everything of the course by its id - questions, exam map, mock and
// full exams - not only the files (it used to leave all those on the old name).
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
      // old folder name. (By name too: a file saved before courseId.)
      await FileItem.updateMany({ userId: req.userId, folder: oldName }, { folder: folder.name, courseId: folder._id });
      await renameCourse(req.userId, folder._id, folder.name);
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
      { folder: 'No Folder', courseId: null }
    );
    // Everything else of the course keeps its name and history, unlinked.
    await removeCourse(req.userId, folder._id);

    res.json({ success: true, deletedId: req.params.id, filesMoved: modifiedCount });
  })
);

module.exports = router;