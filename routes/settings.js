const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { getSingleton } = require('../utils/singleton');

// GET /api/settings/blocked-apps
router.get(
  '/blocked-apps',
  asyncHandler(async (req, res) => {
    const settings = await getSingleton(Settings);
    res.json(settings.blockedApps);
  })
);

// POST /api/settings/blocked-apps  { appName }
router.post(
  '/blocked-apps',
  asyncHandler(async (req, res) => {
    const { appName } = req.body;
    if (!appName) throw new ApiError(400, 'appName is required');
    const settings = await getSingleton(Settings);
    if (!settings.blockedApps.includes(appName)) {
      settings.blockedApps.push(appName);
      await settings.save();
    }
    res.status(201).json(settings.blockedApps);
  })
);

// DELETE /api/settings/blocked-apps/:appName
router.delete(
  '/blocked-apps/:appName',
  asyncHandler(async (req, res) => {
    const settings = await getSingleton(Settings);
    settings.blockedApps = settings.blockedApps.filter((a) => a !== req.params.appName);
    await settings.save();
    res.json(settings.blockedApps);
  })
);

module.exports = router;
