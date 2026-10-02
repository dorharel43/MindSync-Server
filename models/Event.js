const mongoose = require('mongoose');

const eventSchema = new mongoose.Schema(
  {
    // AUTH: see the same field on Task.js - identical reasoning applies here.
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

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
    // One-time events carry their real date (YYYY-MM-DD, local). Events
    // without a date repeat every week on `day` - that's how classes work.
    // Before this field existed EVERY event repeated weekly, so an exam or
    // "submit on 26/10" landed on this week's Monday and came back every
    // Monday forever. `day` is still stored for one-time events too (it's
    // the date's weekday), so older clients keep working.
    date: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'],
    },
    // Weekly events only: the last day it repeats (YYYY-MM-DD, inclusive).
    // null = every week with no end. Without it, a class imported from a
    // syllabus kept filling the board (and Google Calendar) long after the
    // semester ended. Ignored on one-time events.
    until: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Until must be YYYY-MM-DD'],
    },
    // Weekly events only: the first day it can happen (YYYY-MM-DD). null =
    // from whenever it was added. A timetable uploaded two weeks before the
    // semester filled those two weeks with classes that weren't happening.
    from: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'From must be YYYY-MM-DD'],
    },
    // The same id on every class added by one timetable upload, so a wrong
    // upload can be deleted in one go instead of class by class.
    importId: {
      type: String,
      default: null,
      maxlength: 64,
    },
    // Where it happens (a room, "בניין 7 חדר 101") - from a timetable photo,
    // shown on the card and copied to Google Calendar's location.
    location: {
      type: String,
      default: '',
      trim: true,
      maxlength: [200, 'Location must be at most 200 characters'],
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
      maxlength: 300,
    },
  },
  { timestamps: true }
);

// The weekly board's own query - all of my events, in time order.
eventSchema.index({ userId: 1, time: 1 });

module.exports = mongoose.model('Event', eventSchema);