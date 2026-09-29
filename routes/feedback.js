const express = require('express');
const router = express.Router();
const Feedback = require('../models/Feedback');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// POST /api/feedback { text, page }
router.post('/', asyncHandler(async (req, res) => {
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) throw new ApiError(400, 'Feedback is empty.');
    // A simple brake on accidental repeats / spam: 20 a day per user.
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    if (await Feedback.countDocuments({ userId: req.userId, createdAt: { $gte: since } }) >= 20) {
        throw new ApiError(429, 'That\'s a lot of feedback for one day - thank you! Try again tomorrow.');
    }
    await Feedback.create({
        userId: req.userId,
        text: text.slice(0, 4000),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 400),
        page: String((req.body && req.body.page) || '').slice(0, 400)
    });
    res.status(201).json({ success: true });
}));

module.exports = router;
