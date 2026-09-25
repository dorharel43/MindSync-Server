const express = require('express');
const router = express.Router();
const FileItem = require('../models/FileItem');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/files - optional ?folder=<name> filter
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { userId: req.userId };
    if (req.query.folder) filter.folder = req.query.folder;

    // ?light=1 leaves out `content`, which holds the entire extracted text of
    // a document. A list of file names was pulling megabytes of PDF text
    // across for no reason - the picker needs the name and the source path.
    const query = FileItem.find(filter).sort({ createdAt: -1 });
    if (req.query.light) query.select('-content');

    res.json(await query);
  })
);

// GET /api/files/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const file = await FileItem.findOne({ _id: req.params.id, userId: req.userId });
    if (!file) throw new ApiError(404, 'File not found');
    res.json(file);
  })
);

// POST /api/files - create
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, content, folder, sourcePath } = req.body;
    const file = await FileItem.create({ userId: req.userId, name, content, folder, sourcePath });
    res.status(201).json(file);
  })
);

// PUT /api/files/:id - rename or move to a different folder
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, content, folder, sourcePath, summary } = req.body;
    const update = { name, content, folder, sourcePath };
    // Stamp the time only when a summary is actually being written, so the
    // client can show "saved <date>" - renaming a file shouldn't touch it.
    if (summary !== undefined) {
      update.summary = summary;
      update.summaryUpdatedAt = new Date();
    }
    const file = await FileItem.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      update,
      { new: true, runValidators: true, omitUndefined: true }
    );
    if (!file) throw new ApiError(404, 'File not found');
    res.json(file);
  })
);

// DELETE /api/files/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const file = await FileItem.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!file) throw new ApiError(404, 'File not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;
