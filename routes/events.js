const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const asyncHandler = require('../middleware/asyncHandler');
const { assertRoom } = require('../middleware/perUserCap');
const ApiError = require('../middleware/ApiError');
const Folder = require('../models/Folder');
const { examCourseId } = require('../utils/courses');

// An exam's course (8/10). Picked by the student: one of their courses (or
// none, null) - and kept as picked. Not picked: the one course its title
// names, none when unsure - guessed again only when the title changes.
async function pickedCourse(userId, picked) {
  if (picked === null || picked === '') return null;
  if (!/^[a-f0-9]{24}$/i.test(String(picked))) throw new ApiError(400, 'Unknown course');
  const own = await Folder.findOne({ _id: picked, userId }).select('_id').lean();
  if (!own) throw new ApiError(400, 'Unknown course');
  return own._id;
}
async function courseFields(userId, body, old) {
  const type = body.type !== undefined ? body.type : old && old.type;
  // A pick is a course sent that differs from the stored one - the app echoes
  // the whole event back after a Google sync, the guessed course with it.
  // (None, null, is a pick too: kept.)
  if (body.courseId !== undefined) {
    const courseId = await pickedCourse(userId, body.courseId);
    if (old && String(courseId || '') === String(old.courseId || '')) return {};
    return { courseId, coursePicked: true };
  }
  if (type !== 'exam') return {};
  if (old && old.coursePicked) return {};
  const titleChanged = !old || (body.title !== undefined && body.title !== old.title) || old.type !== 'exam';
  if (!titleChanged && old.courseId !== undefined) return {};
  return { courseId: await examCourseId(userId, body.title !== undefined ? body.title : old.title || ''), coursePicked: false };
}
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// GET /api/events
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const events = await Event.find({ userId: req.userId }).sort({ time: 1 });
    res.json(events);
  })
);

// GET /api/events/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const event = await Event.findOne({ _id: req.params.id, userId: req.userId });
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
    const { title, day, date, until, from, importId, time, type, location, googleEventId, durationMinutes, autoScheduled, task } = req.body;
    await assertRoom(Event, req.userId);
    const event = await Event.create({
      userId: req.userId,
      title, day, date, until, from, importId, time, type, location, googleEventId, durationMinutes, autoScheduled, task,
      ...(await courseFields(req.userId, req.body, null))
    });
    res.status(201).json(event);
  })
);

// PUT /api/events/:id
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { title, day, date, until, from, importId, time, type, location, googleEventId, durationMinutes, autoScheduled, task } = req.body;
    const update = { title, day, date, until, from, importId, time, type, location, googleEventId, durationMinutes, autoScheduled, task };
    const old = await Event.findOne({ _id: req.params.id, userId: req.userId }).select('type title courseId coursePicked').lean();
    if (!old) throw new ApiError(404, 'Event not found');
    Object.assign(update, await courseFields(req.userId, req.body, old));
    const event = await Event.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      update,
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
    const result = await Event.deleteMany({ task: req.params.taskId, userId: req.userId, autoScheduled: true });
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
    const result = await Event.deleteMany({ userId: req.userId, autoScheduled: true });
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
    const event = await Event.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!event) throw new ApiError(404, 'Event not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;