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

// The nonce cookie ties the callback to this browser (see rpc/google.js).
const NONCE_COOKIE = 'ms_gnonce';
function readCookie(req, name) {
    const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(`${name}=`));
    return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function nonceCookie(req, value, maxAge) {
    const secure = req.secure ? '; Secure' : '';
    return `${NONCE_COOKIE}=${encodeURIComponent(value)}; Path=/api/google; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

router.post('/connect', requireAuth, asyncHandler(async (req, res) => {
    if (!google.isConfigured()) throw new ApiError(503, 'Google Calendar isn\'t available on this server yet.');
    const nonce = require('crypto').randomBytes(16).toString('hex');
    res.set('Set-Cookie', nonceCookie(req, nonce, 15 * 60));
    res.json({ url: google.connectUrl(req.userId, req.body && req.body.returnTo, nonce) });
}));

router.post('/disconnect', requireAuth, asyncHandler(async (req, res) => {
    res.json(await google.disconnect(req.userId));
}));

// The page the person sees for a moment after Google. It tells the app's
// open tabs "Google changed" and closes itself (it was opened as a small
// window); if it was a full-page visit instead, it goes back to the app.
function resultPage(res, ok, message) {
    const safe = String(message).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    // The one inline script on the site: allowed by a one-time nonce.
    const nonce = require('crypto').randomBytes(16).toString('base64');
    res.set('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`);
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
<script nonce="${nonce}">
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
        // Any other value is shown as a fixed sentence - never the text from
        // the URL, which anyone can write.
        return resultPage(res, false, error === 'access_denied'
            ? 'You cancelled on Google\'s page. You can connect any time from Settings.'
            : 'Google didn\'t finish the connection. Try again from Settings.');
    }
    if (!code || !state) return resultPage(res, false, 'This link is incomplete. Start again from Settings.');
    const nonce = readCookie(req, NONCE_COOKIE);
    res.append('Set-Cookie', nonceCookie(req, '', 0));   // used once
    try {
        await google.finishConnect(String(code), String(state), nonce);
        return resultPage(res, true, 'Your MindSync events will appear in a calendar called "MindSync". You can close this window.');
    } catch (err) {
        console.error('❌ Google connect failed:', err.message);
        if (err.otherBrowser) return resultPage(res, false, 'Finish connecting in the same browser you started in. Start again from Settings.');
        const expired = /jwt|expired|invalid signature|wrong purpose/i.test(err.message);
        // Our own messages (GoogleError, e.g. "leave the calendar box ticked")
        // tell the person what to do - keep them. Anything else is internal.
        const ours = !!err.forPeople;
        return resultPage(res, false, expired ? 'This link expired. Start again from Settings.'
            : ours ? err.message : 'Google Calendar could not be connected. Try again from Settings.');
    }
});

module.exports = router;
