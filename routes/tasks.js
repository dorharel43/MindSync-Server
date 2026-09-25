const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

// AUTH: every route below only ever touches the caller's own tasks.
// Applied once here rather than per-route so a new route added later can't
// forget it.
router.use(requireAuth);

// GET /api/tasks - list all, newest first.
// Optional filters: ?status=open|completed  ?category=<name>
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = { userId: req.userId };
    if (req.query.status) filter.status = req.query.status;
    if (req.query.category !== undefined) filter.category = req.query.category;

    const tasks = await Task.find(filter).sort({ createdAt: -1 });
    res.json(tasks);
  })
);

// GET /api/tasks/categories - distinct category names currently in use,
// so the client can render a filter bar without fetching every task first.
// NOTE: must be declared BEFORE '/:id', or Express matches "categories" as an id.
router.get(
  '/categories',
  asyncHandler(async (req, res) => {
    const categories = await Task.distinct('category', { userId: req.userId, category: { $ne: '' } });
    res.json(categories.sort());
  })
);

// GET /api/tasks/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    // findOne with both _id and userId, not findById - findById alone would
    // return (and later, findByIdAndUpdate/findByIdAndDelete would let you
    // modify) another user's task if you simply knew or guessed its id.
    const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
    if (!task) throw new ApiError(404, 'Task not found');
    res.json(task);
  })
);

// POST /api/tasks - create.
// `subtasks` may be a plain array of strings (["שאלה 1", "שאלה 2"]) or of
// objects - we normalize so the client can send whichever is convenient.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { title, date, dueDate, estimatedMinutes, urgency, category, subtasks } = req.body;

    const normalizedSubtasks = Array.isArray(subtasks)
      ? subtasks.map((s) => (typeof s === 'string' ? { title: s, completed: false } : { title: s.title, completed: !!s.completed }))
      : [];

    const task = await Task.create({
      userId: req.userId,
      title, date, dueDate, estimatedMinutes, urgency, category,
      subtasks: normalizedSubtasks
    });
    res.status(201).json(task);
  })
);

// PUT /api/tasks/:id - update title/date/urgency/category/status
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { title, date, dueDate, estimatedMinutes, urgency, category, status } = req.body;
    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, userId: req.userId },
      { title, date, dueDate, estimatedMinutes, urgency, category, status },
      { new: true, runValidators: true, omitUndefined: true }
    );
    if (!task) throw new ApiError(404, 'Task not found');
    res.json(task);
  })
);

// ==========================================
// Subtask (checklist) operations
// ==========================================

// POST /api/tasks/:id/subtasks  { title }  - add one checklist item
router.post(
  '/:id/subtasks',
  asyncHandler(async (req, res) => {
    const { title } = req.body;
    if (!title || !title.trim()) throw new ApiError(400, 'Subtask title is required');

    const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
    if (!task) throw new ApiError(404, 'Task not found');

    task.subtasks.push({ title: title.trim(), completed: false });
    // BUG FIX: adding a step to a finished task left it "completed" with an
    // unchecked step in it. A new step means there's work left - reopen.
    task.status = 'open';
    await task.save();
    res.status(201).json(task);
  })
);

// PATCH /api/tasks/:id/subtasks/:subtaskId  { completed?, title? }
// Toggling a checklist item is the most frequent write in this feature, so
// it gets its own narrow endpoint rather than resending the whole array.
router.patch(
  '/:id/subtasks/:subtaskId',
  asyncHandler(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
    if (!task) throw new ApiError(404, 'Task not found');

    const subtask = task.subtasks.id(req.params.subtaskId);
    if (!subtask) throw new ApiError(404, 'Subtask not found');

    if (req.body.completed !== undefined) subtask.completed = !!req.body.completed;
    if (req.body.title !== undefined) subtask.title = req.body.title;

    // Keep the parent status honest: ticking the last item completes the
    // task, un-ticking an item reopens it.
    // BUG FIX: this used to set 'open' whenever ANY item was unchecked. A
    // task marked Done while it still had unchecked steps (the client asks
    // first) then reopened itself the moment you ticked one more of them -
    // ticking a step never means "I'm not done". Now only un-ticking reopens.
    if (task.subtasks.length > 0) {
      const allDone = task.subtasks.every((s) => s.completed);
      if (allDone) task.status = 'completed';
      else if (req.body.completed === false) task.status = 'open';
    }

    await task.save();
    res.json(task);
  })
);

// DELETE /api/tasks/:id/subtasks/:subtaskId
router.delete(
  '/:id/subtasks/:subtaskId',
  asyncHandler(async (req, res) => {
    const task = await Task.findOne({ _id: req.params.id, userId: req.userId });
    if (!task) throw new ApiError(404, 'Task not found');

    const subtask = task.subtasks.id(req.params.subtaskId);
    if (!subtask) throw new ApiError(404, 'Subtask not found');

    subtask.deleteOne();

    // Removing the last unchecked step finishes the task. Removing a step
    // never reopens one (same reasoning as the PATCH above).
    if (task.subtasks.length > 0 && task.subtasks.every((s) => s.completed)) {
      task.status = 'completed';
    }

    await task.save();
    res.json(task);
  })
);

// DELETE /api/tasks/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await Task.findOneAndDelete({ _id: req.params.id, userId: req.userId });
    if (!task) throw new ApiError(404, 'Task not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;