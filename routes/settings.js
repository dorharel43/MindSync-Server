const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const { requireAuth } = require('../middleware/auth');

router.use(requireAuth);

// AUTH CHANGE: this used to go through utils/singleton.js's getSingleton(),
// which finds-or-creates the ONE Settings document with no filter at all.
// That helper is for a genuinely global singleton and doesn't take a filter,
// so it can't be reused for "one settings doc per user" - this finds-or-
// creates scoped to req.userId instead.
async function getSettingsForUser(userId) {
  let settings = await Settings.findOne({ userId });
  if (!settings) {
    settings = await Settings.create({ userId });
  }
  return settings;
}

// GET /api/settings/blocked-apps
router.get(
  '/blocked-apps',
  asyncHandler(async (req, res) => {
    const settings = await getSettingsForUser(req.userId);
    res.json(settings.blockedApps);
  })
);

// POST /api/settings/blocked-apps  { appName }
router.post(
  '/blocked-apps',
  asyncHandler(async (req, res) => {
    const appName = typeof req.body.appName === 'string' ? req.body.appName.trim() : '';
    if (!appName) throw new ApiError(400, 'appName is required');
    if (appName.length > 100) throw new ApiError(400, 'That app name is too long.');
    const settings = await getSettingsForUser(req.userId);
    if (settings.blockedApps.length >= 100) throw new ApiError(400, 'The block list is full (100 apps).');
    if (!settings.blockedApps.includes(appName)) {
      settings.blockedApps.push(appName);
      await settings.save({ validateModifiedOnly: true });
    }
    res.status(201).json(settings.blockedApps);
  })
);

// DELETE /api/settings/blocked-apps/:appName
router.delete(
  '/blocked-apps/:appName',
  asyncHandler(async (req, res) => {
    const settings = await getSettingsForUser(req.userId);
    settings.blockedApps = settings.blockedApps.filter((a) => a !== req.params.appName);
    await settings.save({ validateModifiedOnly: true });
    res.json(settings.blockedApps);
  })
);

module.exports = router;