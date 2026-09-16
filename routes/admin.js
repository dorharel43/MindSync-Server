const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const Event = require('../models/Event');
const Folder = require('../models/Folder');
const FileItem = require('../models/FileItem');
const StudyItem = require('../models/StudyItem');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

router.use(requireAuth);

// POST /api/admin/hard-reset - wipes the CALLER's data only.
// BUG FIX: this used to be Model.deleteMany({}) with no filter - a hard
// reset for one person would have wiped every user's tasks, events,
// folders and files. Also now includes StudyItem, which the original
// reset never touched despite the client calling this "reset all data".
router.post(
  '/hard-reset',
  asyncHandler(async (req, res) => {
    await Promise.all([
      Task.deleteMany({ userId: req.userId }),
      Event.deleteMany({ userId: req.userId }),
      Folder.deleteMany({ userId: req.userId }),
      FileItem.deleteMany({ userId: req.userId }),
      StudyItem.deleteMany({ userId: req.userId }),
    ]);
    res.json({ success: true });
  })
);

module.exports = router;