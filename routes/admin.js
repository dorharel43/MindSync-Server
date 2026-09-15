const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const Event = require('../models/Event');
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const asyncHandler = require('../middleware/asyncHandler');

// POST /api/admin/hard-reset - wipes everything except profile/settings.
router.post(
  '/hard-reset',
  asyncHandler(async (req, res) => {
    await Promise.all([Task.deleteMany({}), Event.deleteMany({}), Folder.deleteMany({}), FileItem.deleteMany({})]);
    res.json({ success: true });
  })
);

module.exports = router;