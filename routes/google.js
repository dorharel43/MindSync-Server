// Google Calendar connection for the web version (the logic is in
// rpc/google.js).
//
//   GET  /api/google/status      -> { configured, connected, email }
//   POST /api/google/connect     -> { url }   the Google page to send the person to
//   GET  /api/google/callback    <- Google sends the person back here
//   POST /api/google/disconnect  -> { success }
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const ApiError = require('../middleware/ApiError');
const google = require('../rpc/google');

const router = express.Router();

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
    res.json(await google.status(req.userId));
}));

router.post('/connect', requireAuth, asyncHandler(async (req, res) => {
    if (!google.isConfigured()) throw new ApiError(503, 'Google Calendar isn\'t available on this server yet.');
    res.json({ url: google.connectUrl(req.userId, req.body && req.body.returnTo) });
}));

router.post('/disconnect', requireAuth, asyncHandler(async (req, res) => {
    res.json(await google.disconnect(req.userId));
}));

// The page the person sees for a moment after Google. It tells the app's
// open tabs "Google changed" and closes itself (it was opened as a small
// window); if it was a full-page visit instead, it goes back to the app.
function resultPage(res, ok, message) {
    const safe = String(message).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    res.status(ok ? 200 : 400).type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MindSync - Google Calendar</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background: #f6f7fb; color: #1d2433; display: grid; place-items: center; min-height: 100vh; margin: 0; }
  .box { background: #fff; border-radius: 14px; padding: 28px 32px; max-width: 380px; text-align: center; box-shadow: 0 6px 24px rgba(0,0,0,.08); }
  h1 { font-size: 20px; margin: 0 0 8px; } p { margin: 0 0 16px; line-height: 1.5; } a { color: #4f46e5; }
  button { font: inherit; padding: 6px 16px; border-radius: 8px; border: 1px solid #d4d7e1; background: #fff; cursor: pointer; }
</style></head>
<body><div class="box">
  <h1>${ok ? 'Google Calendar connected ✓' : 'Not connected'}</h1>
  <p>${safe}</p>
  <p>${ok ? '<a href="/app/">Back to MindSync</a>' : '<button id="close" type="button">Close</button> &nbsp; <a href="/app/?google=failed">Back to MindSync</a>'}</p>
</div>
<script>
  try { new BroadcastChannel('mindsync').postMessage('google-changed'); } catch (e) {}
  // Success closes by itself. A failure STAYS until the person closes it -
  // it used to vanish after 4 seconds, before anyone could read why.
  ${ok
    ? `if (window.opener) setTimeout(function () { window.close(); }, 1200);
  else setTimeout(function () { location.replace('/app/?google=connected'); }, 1200);`
    : `document.getElementById('close').onclick = function () { if (window.opener) window.close(); else location.replace('/app/?google=failed'); };`}
</script>
</body></html>`);
}

router.get('/callback', async (req, res) => {
    const { code, state, error } = req.query;
    if (error) {
        // access_denied = they pressed Cancel on Google's page.
        return resultPage(res, false, error === 'access_denied'
            ? 'You cancelled on Google\'s page. You can connect any time from Settings.'
            : `Google said: ${error}`);
    }
    if (!code || !state) return resultPage(res, false, 'This link is incomplete. Start again from Settings.');
    try {
        await google.finishConnect(String(code), String(state));
        return resultPage(res, true, 'Your MindSync events will appear in a calendar called "MindSync". You can close this window.');
    } catch (err) {
        console.error('❌ Google connect failed:', err.message);
        const expired = /jwt|expired|invalid signature|wrong purpose/i.test(err.message);
        return resultPage(res, false, expired ? 'This link expired. Start again from Settings.' : err.message);
    }
});

module.exports = router;
