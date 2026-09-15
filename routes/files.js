const express = require('express');
const router = express.Router();
const FileItem = require('../models/FileItem');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');

// GET /api/files - optional ?folder=<name> filter
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = req.query.folder ? { folder: req.query.folder } : {};

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
    const file = await FileItem.findById(req.params.id);
    if (!file) throw new ApiError(404, 'File not found');
    res.json(file);
  })
);

// POST /api/files - create
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, content, folder, sourcePath } = req.body;
    const file = await FileItem.create({ name, content, folder, sourcePath });
    res.status(201).json(file);
  })
);

// PUT /api/files/:id - rename or move to a different folder
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { name, content, folder, sourcePath } = req.body;
    const file = await FileItem.findByIdAndUpdate(
      req.params.id,
      { name, content, folder, sourcePath },
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
    const file = await FileItem.findByIdAndDelete(req.params.id);
    if (!file) throw new ApiError(404, 'File not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;