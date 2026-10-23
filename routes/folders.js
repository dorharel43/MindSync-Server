const express = require('express');
const router = express.Router();
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const { renameCourse, renameClash, adoptByName, removeCourse, mergeCourse, absorbName, NO_COURSE } = require('../utils/courses');
// The app's own names for "no course" and its upload choices ("__newcourse__",
// "__new__:<name>") can't be a course's name (8/10).
const reservedName = (name) => {
  const n = String(name == null ? '' : name).trim();
  return (n !== '' && NO_COURSE.has(n)) || n.startsWith('__');
};
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

// POST /api/folders - create. A folder is a course (8/10): it takes in what
// already carries its name with no course (a course typed on questions, a
// deleted folder's history).
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name } = req.body;
    if (reservedName(name)) throw new ApiError(400, 'This name is taken by the app - choose another.');
    await assertRoom(Folder, req.userId);
    const folder = await Folder.create({ userId: req.userId, name });
    await adoptByName(req.userId, folder._id, folder.name);
    res.status(201).json(folder);
  })
);

// PUT /api/folders/:id - rename. The rename reaches everything of the course
// by its id - questions, exam map, mock and full exams - not only the files
// (it used to leave all those on the old name). Everything else first, the
// folder's own name last: if anything fails half way the folder keeps its
// old name, and renaming again finishes the job.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const oldFolder = await Folder.findOne({ _id: req.params.id, userId: req.userId });
    if (!oldFolder) throw new ApiError(404, 'Folder not found');
    const name = String(req.body.name == null ? '' : req.body.name).trim();
    if (!name) throw new ApiError(400, 'Folder name is required');
    if (name.length > 100) throw new ApiError(400, 'Course name is too long (max 100 characters)');
    if (reservedName(name)) throw new ApiError(400, 'This name is taken by the app - choose another.');
    if (name !== oldFolder.name) {
      if (await Folder.findOne({ userId: req.userId, name, _id: { $ne: oldFolder._id } }).select('_id').lean()) {
        throw new ApiError(409, 'You already have a course with this name.');
      }
      if (await renameClash(req.userId, oldFolder._id, name)) {
        throw new ApiError(409, 'There is already exam data under this name (from a course you deleted). Choose another name.');
      }
      // Scoped by userId too - otherwise renaming your own folder could
      // silently reassign a different user's files that happen to share the
      // old folder name. (By name too: a file saved before courseId.)
      await FileItem.updateMany({ userId: req.userId, folder: oldFolder.name }, { folder: name, courseId: oldFolder._id });
      await renameCourse(req.userId, oldFolder._id, name);
    }
    let folder;
    try {
      folder = await Folder.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        { name },
        { new: true, runValidators: true }
      );
    } catch (err) {
      // A course of that name was made in the meantime: everything goes back
      // to the old name, as if the rename never started.
      if (err && err.code === 11000 && name !== oldFolder.name) {
        await FileItem.updateMany({ userId: req.userId, courseId: oldFolder._id }, { folder: oldFolder.name });
        await renameCourse(req.userId, oldFolder._id, oldFolder.name);
        throw new ApiError(409, 'You already have a course with this name.');
      }
      throw err;
    }
    res.json(folder);
  })
);

// POST /api/folders/:id/merge { into } - this course into another of the
// student's: everything of it moves there, then it is deleted (23/10).
router.post(
  '/:id/merge',
  asyncHandler(async (req, res) => {
    const isId = (v) => /^[a-f0-9]{24}$/i.test(String(v || ''));
    if (!isId(req.params.id)) throw new ApiError(404, 'Folder not found');
    const from = await Folder.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!from) throw new ApiError(404, 'Folder not found');
    const into = isId(req.body.into) && String(req.body.into) !== String(from._id)
      ? await Folder.findOne({ _id: req.body.into, userId: req.userId }).lean() : null;
    if (!into) throw new ApiError(400, 'Choose another of your courses to merge into.');
    const moved = await mergeCourse(req.userId, from, into);
    res.json({ success: true, into: { id: into._id, name: into.name }, moved });
  })
);

// POST /api/folders/:id/absorb { name } - what carries a name that is no
// course (questions of a course typed by hand, a deleted course's history)
// becomes this course's (23/10).
router.post(
  '/:id/absorb',
  asyncHandler(async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(String(req.params.id || ''))) throw new ApiError(404, 'Folder not found');
    const into = await Folder.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!into) throw new ApiError(404, 'Folder not found');
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || NO_COURSE.has(name) || name.length > 200) throw new ApiError(400, 'Nothing to move.');
    // (a name that IS a course: its tasks, which carry only a name, would move
    // too - that's a merge, not this)
    if (name !== into.name && await Folder.exists({ userId: req.userId, name })) throw new ApiError(400, 'That name is one of your courses - merge it instead.');
    const moved = await absorbName(req.userId, name, into);
    res.json({ success: true, into: { id: into._id, name: into.name }, moved });
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