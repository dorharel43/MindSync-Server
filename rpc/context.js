// Per-request context for the ported app logic (rpc/handlers.js).
//
// The desktop app's main.js was written for ONE user per process: a single
// `api` client with one token, `event.sender.send(...)` to tell the one window
// to refresh. On the server every request belongs to a different user, so
// that per-user state lives here, in an AsyncLocalStorage "store" that
// follows the request through every await - including background work the
// handler starts and doesn't wait for. That is what lets handlers.js keep
// main.js's code almost unchanged.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// ctx: { token, userId, events: Set<string> }
function run(ctx, fn) {
    return als.run(ctx, fn);
}

function currentContext() {
    return als.getStore() || null;
}

module.exports = { run, currentContext };
