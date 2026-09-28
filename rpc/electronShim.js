// Stand-ins for the parts of Electron that main.js used, so its handlers can
// run unchanged on the server (see handlers.js).
//
//   ipcMain.handle(name, fn)  -> registers fn as an RPC channel
//   ipcMain.on(...)           -> desktop-only events (focus mode); ignored
//   BrowserWindow.getAllWindows()[i].webContents.send('events-changed')
//                             -> recorded on the current request, and sent
//                                back to the browser with the response, which
//                                then refreshes that part of the screen
const { currentContext } = require('./context');

const handlers = new Map();

const ipcMain = {
    handle(name, fn) { handlers.set(name, fn); },
    on() { /* desktop-only */ }
};

function recordEvent(channel) {
    const ctx = currentContext();
    if (ctx && ctx.events) ctx.events.add(channel);
}

const fakeWindow = {
    isDestroyed: () => false,
    webContents: { send: recordEvent }
};

const BrowserWindow = { getAllWindows: () => [fakeWindow] };

// What a handler receives as `event`: event.sender.send('tasks-changed').
function makeEvent() {
    return { sender: { send: recordEvent, isDestroyed: () => false } };
}

module.exports = { ipcMain, BrowserWindow, handlers, makeEvent };
