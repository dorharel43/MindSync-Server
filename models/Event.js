const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Event title is required'],
      trim: true,
      maxlength: [300, 'Event title is too long (max 300 characters)'],
    },
    day: {
      type: String,
      required: [true, 'Event day is required'],
      enum: {
        values: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        message: '{VALUE} is not a valid day',
      },
    },
    time: {
      type: String,
      required: [true, 'Event time is required'],
      match: [/^([01]\d|2[0-3]):([0-5]\d)$/, 'Time must be in HH:MM 24-hour format'],
    },
    type: {
      type: String,
      enum: {
        values: ['lesson', 'exam', 'study', 'personal'],
        message: '{VALUE} is not a valid event type',
      },
      default: 'personal',
    },
    // How long it runs, in minutes. Optional on purpose: you can add a lesson
    // to the week without knowing how long it is, and most people do. When it
    // is missing the planner assumes an hour rather than refusing to work.
    durationMinutes: {
      type: Number,
      default: null,
      min: [5, 'An event shorter than 5 minutes is not worth scheduling'],
      max: [720, 'An event longer than 12 hours is almost certainly a mistake'],
    },

    // Set when this block was placed by the weekly planner rather than by
    // hand. Re-planning clears these and leaves everything the user entered
    // themselves untouched - without the flag there is no way to tell them
    // apart, and re-running would either duplicate blocks or delete real ones.
    autoScheduled: {
      type: Boolean,
      default: false,
    },

    // Which task this block is working on, when it is a planned one.
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Task',
      default: null,
    },

    // Set when mirrored into Google Calendar. That OAuth flow stays in the
    // Electron main process (it owns the token), not in this server.
    googleEventId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Event', eventSchema);