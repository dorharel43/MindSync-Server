const mongoose = require('mongoose');

// A single checklist item inside a task (e.g. "שאלה 1", "פרק א'").
// Kept as a subdocument so each one gets its own _id - that's what the
// client uses to toggle a specific item without touching the others.
const subtaskSchema = new mongoose.Schema({
    title: {
        type: String,
        required: [true, 'Subtask title is required'],
        trim: true,
        maxlength: [200, 'Subtask title is too long (max 200 characters)']
    },
    completed: {
        type: Boolean,
        default: false
    }
});

const taskSchema = new mongoose.Schema({
    // AUTH: every document now belongs to exactly one user. Every route that
    // reads/writes a Task must filter/set this - see tasks.js. Without it,
    // Task.find() returns everyone's tasks, which is the exact bug this
    // whole change exists to close.
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },

    title: {
        type: String,
        required: true,
        trim: true
    },
    // Restored: the AI task-extraction flow sends this field.
    date: {
        type: String,
        default: 'Not set',
        trim: true
    },
    // The deadline as an actual date, for anything that needs to compare or
    // sort by it - the weekly planner above all.
    //
    // `date` above stays as it is: it holds whatever the user or the AI
    // extraction wrote ("יום חמישי", "15/09", "Not set") and is what gets
    // displayed. Two fields for one idea is debt, and they should be merged
    // once nothing depends on the string - but a deadline you cannot compare
    // is not a constraint, and that is what blocks scheduling today.
    dueDate: {
        type: Date,
        default: null
    },

    // Roughly how long this will take. The planner needs a length to fit a
    // task into a gap; null means "no idea", and it assumes an hour.
    estimatedMinutes: {
        type: Number,
        default: null,
        min: [5, 'Nothing meaningful takes under 5 minutes'],
        max: [600, 'Anything over 10 hours should be split into smaller tasks']
    },

    // Free-text grouping label, e.g. "מבחן מסדי נתונים", "עבודה בסטטיסטיקה".
    // Empty string means "uncategorized" - we deliberately don't use null so
    // grouping logic on the client doesn't have to special-case it.
    category: {
        type: String,
        default: '',
        trim: true,
        maxlength: [100, 'Category name is too long (max 100 characters)']
    },
    urgency: {
        type: String,
        enum: ['Normal', 'Medium', 'High', 'Urgent'], // רמות הדחיפות שהגדרנו למערכת ה-XP
        default: 'Normal'
    },
    status: {
        type: String,
        enum: ['open', 'completed'],
        default: 'open'
    },
    subtasks: {
        type: [subtaskSchema],
        default: []
    }
}, {
    timestamps: true, // יוסיף אוטומטית תאריך יצירה ותאריך עדכון
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
});

// The list view is always "my tasks, newest first" - this is the query that
// runs on every page load, so it gets a compound index instead of relying on
// the single-field userId index above plus a separate sort.
taskSchema.index({ userId: 1, createdAt: -1 });

// Progress is DERIVED, never stored - storing it would let it drift out of
// sync with the actual subtasks. A task with no subtasks reports progress
// based on its own status instead, so the UI has one consistent number.
taskSchema.virtual('progress').get(function () {
    if (!this.subtasks || this.subtasks.length === 0) {
        return this.status === 'completed' ? 100 : 0;
    }
    const done = this.subtasks.filter(s => s.completed).length;
    return Math.round((done / this.subtasks.length) * 100);
});

taskSchema.virtual('completedCount').get(function () {
    if (!this.subtasks) return 0;
    return this.subtasks.filter(s => s.completed).length;
});

module.exports = mongoose.model('Task', taskSchema);