// Server-side replacement for the desktop authClient.js: the token is the one
// the browser sent with THIS request (rpc/context.js), not a file on disk.
const { currentContext } = require('./context');

function getToken() {
    const ctx = currentContext();
    return ctx ? ctx.token : null;
}

module.exports = {
    getToken,
    getUser: () => null,
    // The browser owns the session; a 401 is passed back to it as an error
    // and it logs the user out there.
    clearSession() {},
    saveSession() {},
    initSession() {},
    readSession: () => null
};
