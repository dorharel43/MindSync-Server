const express = require('express');
const router = express.Router();
const Task = require('../models/Task');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');

// GET /api/tasks - list all, newest first.
// Optional filters: ?status=open|completed  ?category=<name>
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = {};
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
    const categories = await Task.distinct('category', { category: { $ne: '' } });
    res.json(categories.sort());
  })
);

// GET /api/tasks/:id
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
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

    const task = await Task.create({ title, date, dueDate, estimatedMinutes, urgency, category, subtasks: normalizedSubtasks });
    res.status(201).json(task);
  })
);

// PUT /api/tasks/:id - update title/date/urgency/category/status
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { title, date, dueDate, estimatedMinutes, urgency, category, status } = req.body;
    const task = await Task.findByIdAndUpdate(
      req.params.id,
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

    const task = await Task.findById(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');

    task.subtasks.push({ title: title.trim(), completed: false });
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
    const task = await Task.findById(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');

    const subtask = task.subtasks.id(req.params.subtaskId);
    if (!subtask) throw new ApiError(404, 'Subtask not found');

    if (req.body.completed !== undefined) subtask.completed = !!req.body.completed;
    if (req.body.title !== undefined) subtask.title = req.body.title;

    // Keep the parent status honest: if every item is checked the task is
    // done; if any item is unchecked it's back to open. This means the
    // checklist is the single source of truth and status can't contradict it.
    if (task.subtasks.length > 0) {
      const allDone = task.subtasks.every((s) => s.completed);
      task.status = allDone ? 'completed' : 'open';
    }

    await task.save();
    res.json(task);
  })
);

// DELETE /api/tasks/:id/subtasks/:subtaskId
router.delete(
  '/:id/subtasks/:subtaskId',
  asyncHandler(async (req, res) => {
    const task = await Task.findById(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');

    const subtask = task.subtasks.id(req.params.subtaskId);
    if (!subtask) throw new ApiError(404, 'Subtask not found');

    subtask.deleteOne();

    if (task.subtasks.length > 0) {
      const allDone = task.subtasks.every((s) => s.completed);
      task.status = allDone ? 'completed' : 'open';
    }

    await task.save();
    res.json(task);
  })
);

// DELETE /api/tasks/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const task = await Task.findByIdAndDelete(req.params.id);
    if (!task) throw new ApiError(404, 'Task not found');
    res.json({ success: true, deletedId: req.params.id });
  })
);

module.exports = router;