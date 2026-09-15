const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');

// GET /api/events
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const events = await Event.find().sort({ time: 1 });
    res.json(events);
  })
);

// GET /api/events/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const event = await Event.findById(req.params.id);
    if (!event) throw new ApiError(404, 'Event not found');
    res.json(event);
  })
);

// POST /api/events - create
// Note: only persists the event. Mirroring into Google Calendar is done by
// the Electron main process (it owns the OAuth token), which then PUTs
// googleEventId back onto this record if that succeeds.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { title, day, time, type, googleEventId, durationMinutes, autoScheduled, task } = req.body;
    const event = await Event.create({ title, day, time, type, googleEventId, durationMinutes, autoScheduled, task });
    res.status(201).json(event);
  })
);

// PUT /api/events/:id
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { title, day, time, type, googleEventId, durationMinutes, autoScheduled, task } = req.body;
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { title, day, time, type, googleEventId, durationMinutes, autoScheduled, task },
      { new: true, runValidators: true, omitUndefined: true }
    );
    if (!event) throw new ApiError(404, 'Event not found');
    res.json(event);
  })
);

// DELETE /api/events/by-task/:taskId
// Clears the planned blocks for one task - used when that task is finished
// or deleted. Only auto-scheduled ones: a block the user put in the calendar
// themselves is their decision to reverse, not ours.
router.delete(
  '/by-task/:taskId',
  asyncHandler(async (req, res) => {
    const result = await Event.deleteMany({ task: req.params.taskId, autoScheduled: true });
    res.json({ success: true, deleted: result.deletedCount });
  })
);

// DELETE /api/events/auto-scheduled
// Removes only blocks the planner placed. Declared before '/:id' so
// "auto-scheduled" isn't matched as an id.
//
// Re-planning has to start from a clean week, and this is the line between
// "the app put it there" and "I put it there" - only the first may be swept.
router.delete(
  '/auto-scheduled',
  asyncHandler(async (req, res) => {
    const result = await Event.deleteMany({ autoScheduled: true });
    res.json({ success: true, deleted: result.deletedCount });
  })
);

// DELETE /api/events/:id
// Only deletes the DB record. Delete the linked Google Calendar event
// *first* (client-side, if googleEventId is set) since this server has no
// OAuth client to do that itself.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) throw new ApiError(404, 'Event not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;