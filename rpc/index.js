// The web app's gateway to the app logic.
//
//   POST /api/rpc/:channel   { args: [...] }  ->  { result, events }
//
// The browser version of the app calls exactly what the desktop app called
// over Electron IPC (ipcRenderer.invoke('generate-study-items-pdf', ...)),
// and the same handler code answers (rpc/handlers.js, generated from the
// desktop main.js). `events` are the "something changed, refresh" signals the
// handler raised ('tasks-changed', 'events-changed'...).
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ApiError = require('../middleware/ApiError');
const context = require('./context');
const { handlers, makeEvent } = require('./electronShim');
require('./handlers'); // registers every channel

const router = express.Router();
const limits = require('../middleware/rateLimit');

// A busy student makes a few calls a second at most (30/9 security pass).
const rpcLimit = limits.rateLimit({
    name: 'rpc-user', windowMs: 60 * 1000, max: Number(process.env.RPC_PER_MIN) || 300, key: limits.byUser,
    message: 'Too many requests - slow down a little and try again in a minute.'
});

// Channels the browser handles itself (login, file picker, new tab...) are
// not callable here even though the desktop code defined some of them.
const BROWSER_ONLY = new Set(['auth-get-session', 'auth-login', 'auth-register', 'auth-change-password', 'auth-logout', 'open-reset-password', 'open-site-page',
    'select-upload-files', 'read-upload-file', 'open-summary-window', 'get-diagnostic-log',
    'pick-application', 'get-suggested-apps', 'toggle-blocking']);

router.post('/:channel', requireAuth, rpcLimit, async (req, res, next) => {
    const channel = req.params.channel;
    const fn = handlers.get(channel);
    if (!fn || BROWSER_ONLY.has(channel)) return next(new ApiError(404, 'Unknown action.'));

    const args = Array.isArray(req.body && req.body.args) ? req.body.args : [];
    const token = (req.headers.authorization || '').slice('Bearer '.length);
    // ip: the AI allowance also counts per network address (30/9) - see rpc/aiUsage.js.
    const ctx = { token, userId: req.userId, ip: require('../middleware/rateLimit').byIp(req), events: new Set() };
    const started = Date.now();
    try {
        const result = await context.run(ctx, () => fn(makeEvent(), ...args));
        res.json({ result: result === undefined ? null : result, events: [...ctx.events] });
    } catch (err) {
        // Handlers catch their own errors almost everywhere; this is the net.
        console.error(`❌ rpc ${channel} failed after ${Date.now() - started}ms:`, err.message);
        // The AI limit text is for the person; anything else unexpected is
        // not shown (it can contain internals) - the log has it.
        next(err.aiLimit ? new ApiError(429, err.message) : err);
    }
});

module.exports = router;
