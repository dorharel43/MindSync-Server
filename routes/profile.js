const express = require('express');
const router = express.Router();
const Profile = require('../models/Profile');
const asyncHandler = require('../middleware/asyncHandler');
const { getSingleton, updateSingleton } = require('../utils/singleton');

// GET /api/profile
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const profile = await getSingleton(Profile);
    res.json(profile);
  })
);

// PUT /api/profile
router.put(
  '/',
  asyncHandler(async (req, res) => {
    const { name, degree } = req.body;
    const profile = await updateSingleton(Profile, { name, degree });
    res.json(profile);
  })
);

module.exports = router;
