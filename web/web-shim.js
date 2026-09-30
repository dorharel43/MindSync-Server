// web-shim.js - runs the desktop app's screens (renderer.js, summary.js) in a
// normal browser.
//
// Those screens talk to "Electron" through require('electron').ipcRenderer:
// ipcRenderer.invoke('get-tasks'), ipcRenderer.invoke('generate-study-items-pdf', ...).
// This file provides that same require('electron') in the browser:
//   - most channels go to the server: POST /api/rpc/<channel> { args }
//     (the same handler code the desktop app runs - server repo, rpc/);
//   - a few are browser things and are done right here: logging in (the
//     token lives in localStorage), picking and uploading files, opening the
//     summary in a new tab, copying to the clipboard;
//   - desktop-only features (focus mode closes other apps) answer "nothing".
// Loaded BEFORE ui.js / icons.js / renderer.js (see tools/sync-web.py).
(function () {
    'use strict';

    window.MINDSYNC_WEB = true;
    document.documentElement.classList.add('is-web');

    const API = '/api';
    const TOKEN_KEY = 'mindsync.token';

    // ---- session ---------------------------------------------------------
    let memoryToken = null; // used if localStorage is blocked (some private modes)
    function getToken() {
        try { return localStorage.getItem(TOKEN_KEY) || memoryToken; } catch { return memoryToken; }
    }
    function setToken(token) {
        memoryToken = token || null;
        try { token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
        if (token) loggedIn();
    }

    // renderer.js starts loading lists (tasks, events...) right away, while
    // the login screen is still up. Instead of failing, those calls wait
    // here and run once the person has logged in.
    let loggedIn;
    const whenLoggedIn = new Promise(resolve => { loggedIn = resolve; });
    if (getToken()) loggedIn();

    // A readable message from whatever the server answered.
    async function readError(res) {
        let msg = `The server answered ${res.status}.`;
        try {
            const data = await res.json();
            msg = (data && data.error && (data.error.message || data.error)) || msg;
        } catch { /* not JSON (e.g. Render's "starting up" page) */
            if (res.status >= 500) msg = 'The server is starting up or restarting - try again in a minute.';
        }
        return typeof msg === 'string' ? msg : JSON.stringify(msg);
    }

    async function api(method, path, body, { auth = true, raw = false, headers = {}, reloadOn401 = true } = {}) {
        const h = { ...headers };
        if (!raw && body !== undefined) h['Content-Type'] = 'application/json';
        const token = getToken();
        if (auth && token) h.Authorization = `Bearer ${token}`;
        let res;
        try {
            res = await fetch(API + path, { method, headers: h, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined });
        } catch (err) {
            throw new Error('Can\'t reach MindSync - check your internet connection.');
        }
        if (res.status === 401 && auth && token) {
            // The session ended (expired / logged out elsewhere): back to login.
            setToken(null);
            if (reloadOn401) window.location.reload();
            throw new Error('Your session ended. Please log in again.');
        }
        if (!res.ok) throw new Error(await readError(res));
        return res.status === 204 ? null : res.json();
    }

    // ---- "refresh" signals ('tasks-changed', 'events-changed', 'files-changed')
    // Raised by the server handler and returned with its answer; also passed
    // to the app's other tabs (the summary tab saving a summary refreshes the
    // file list in the main tab).
    const listeners = {};
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mindsync') : null;
    function emitLocal(name) {
        (listeners[name] || []).forEach(fn => { try { fn({}); } catch (e) { console.error(e); } });
    }
    function emit(names) {
        (names || []).forEach(name => {
            setTimeout(() => emitLocal(name), 0);
            if (channel) channel.postMessage(name);
        });
    }
    if (channel) {
        channel.onmessage = (e) => {
            if (e.data === 'logged-out') { window.location.reload(); return; }
            emitLocal(e.data);
        };
    }

    // ---- files: pick in the browser, upload to the server ----------------
    const SUPPORTED = ['pdf', 'txt', 'md', 'java', 'py', 'js', 'html', 'css', 'json'];
    const MAX_FILES = 100;
    const picked = new Map(); // 'browser:<n>' -> File
    let pickCounter = 0;

    function pickFiles(mode) {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.multiple = true;
            if (mode === 'folder') input.webkitdirectory = true;
            else input.accept = SUPPORTED.map(e => '.' + e).join(',');
            input.style.display = 'none';
            let settled = false;
            const done = (value) => { if (!settled) { settled = true; input.remove(); resolve(value); } };
            input.addEventListener('cancel', () => done(null));
            input.addEventListener('change', () => {
                const all = [...(input.files || [])];
                if (!all.length) return done(null);
                const ok = all.filter(f => SUPPORTED.includes((f.name.split('.').pop() || '').toLowerCase()) && !f.name.startsWith('.') && !f.name.startsWith('~$'))
                    .sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true }));
                const folderName = mode === 'folder' && all[0].webkitRelativePath ? all[0].webkitRelativePath.split('/')[0] : null;
                // Same name in two subfolders -> keep the subfolder in the name
                // (see select-upload-files in the desktop main.js).
                const kept = ok.slice(0, MAX_FILES);
                const baseCount = {};
                kept.forEach(f => { baseCount[f.name] = (baseCount[f.name] || 0) + 1; });
                const files = kept.map(f => {
                    const key = `browser:${++pickCounter}`;
                    picked.set(key, f);
                    const rel = (f.webkitRelativePath || '').split('/').slice(1).join('/');
                    return { path: key, name: baseCount[f.name] > 1 && rel ? rel : f.name };
                });
                done({ files, folderName, truncated: ok.length > MAX_FILES, maxFiles: MAX_FILES, supported: SUPPORTED });
            });
            document.body.appendChild(input);
            input.click();
        });
    }

    async function uploadPicked(key) {
        const file = picked.get(key);
        if (!file) return { error: 'That file is no longer selected - choose it again.' };
        try {
            const data = await api('POST', '/uploads', file, {
                raw: true,
                headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) }
            });
            picked.delete(key);
            return data;
        } catch (err) {
            return { error: err.message };
        }
    }

    // ---- channels answered in the browser -------------------------------
    const local = {
        'auth-get-session': async () => {
            if (!getToken()) return { loggedIn: false };
            try {
                const user = await api('GET', '/auth/me', undefined, { reloadOn401: false });
                return { loggedIn: true, user };
            } catch {
                return { loggedIn: false };
            }
        },
        'auth-login': async ({ email, password }) => {
            try {
                const { token, user } = await api('POST', '/auth/login', { email, password }, { auth: false });
                setToken(token);
                return { success: true, user };
            } catch (err) { return { error: err.message }; }
        },
        'auth-register': async ({ email, password, name, degree }) => {
            try {
                const { token, user } = await api('POST', '/auth/register', { email, password, name, degree }, { auth: false });
                setToken(token);
                return { success: true, user };
            } catch (err) { return { error: err.message }; }
        },
        // A fresh page after logging out: nothing of this account stays on
        // screen or in memory for the next person on this computer.
        // The server asks the password again; a wrong one is a 403 (the
        // session stays). On success the other tabs log out too, and this
        // one goes to the home page once the "deleted" message was seen.
        'auth-delete-account': async (password) => {
            try {
                await api('DELETE', '/auth/me', { password: String(password || '') }, { reloadOn401: false });
            } catch (err) { return { error: err.message }; }
            setToken(null);
            if (channel) channel.postMessage('logged-out');
            setTimeout(() => window.location.replace('/'), 2500);
            return { success: true };
        },
        // New password: other devices are logged out; this tab (and its
        // sibling tabs - same storage) keeps working with the new token.
        'auth-change-password': async ({ currentPassword, newPassword } = {}) => {
            try {
                const { token } = await api('POST', '/auth/change-password',
                    { currentPassword: String(currentPassword || ''), newPassword: String(newPassword || '') }, { reloadOn401: false });
                setToken(token);
                return { success: true };
            } catch (err) { return { error: err.message }; }
        },
        'auth-logout': async () => {
            setToken(null);
            if (channel) channel.postMessage('logged-out');
            window.location.reload();
            return { success: true };
        },

        'select-upload-files': (mode) => pickFiles(mode),
        'read-upload-file': (key) => uploadPicked(key),

        'open-summary-window': async (fileId) => {
            window.open(`summary.html?fileId=${encodeURIComponent(fileId)}`, `summary-${fileId}`);
            return true;
        },

        'send-feedback': async (text) => {
            try { return await api('POST', '/feedback', { text, page: location.pathname + location.hash }); }
            catch (err) { return { error: err.message }; }
        },

        // ---- Google Calendar (per account, on the server: routes/google.js)
        'google-status': async () => {
            try { return await api('GET', '/google/status'); }
            catch (err) { return { configured: false, connected: false, error: err.message }; }
        },
        // Must be called straight from a click: the Google window is opened
        // before anything is awaited, or the browser blocks it as a pop-up.
        'google-connect': (returnTo) => {
            const popup = window.open('', 'mindsync-google', 'width=520,height=700');
            return (async () => {
                let url;
                try {
                    ({ url } = await api('POST', '/google/connect', { returnTo: returnTo || location.hash || '' }));
                } catch (err) {
                    if (popup) popup.close();
                    return { connected: false, error: err.message };
                }
                if (!popup) { window.location.href = url; return new Promise(() => {}); } // pop-ups blocked: go there and come back
                popup.location.href = url;
                // Done when the Google window reports back (callback page) or is closed.
                await new Promise(resolve => {
                    const onMsg = (name) => { if (name === 'google-changed') finish(); };
                    (listeners['google-changed'] = listeners['google-changed'] || []).push(onMsg);
                    const timer = setInterval(() => { if (popup.closed) finish(); }, 500);
                    function finish() {
                        clearInterval(timer);
                        listeners['google-changed'] = (listeners['google-changed'] || []).filter(f => f !== onMsg);
                        resolve();
                    }
                });
                return local['google-status']();
            })();
        },
        'google-disconnect': async () => {
            try { const r = await api('POST', '/google/disconnect'); emit(['google-changed']); return r; }
            catch (err) { return { error: err.message }; }
        },

        // Desktop-only: the web version can't close other programs, read a
        // log file on the computer, or pick an .exe. (Their buttons are
        // hidden - html.is-web .desktop-only.)
        'get-diagnostic-log': async () => '',
        'get-blocked-apps': async () => [],
        'get-suggested-apps': async () => [],
        'add-blocked-app': async () => ({ error: 'Focus mode is only in the desktop app.' }),
        'remove-blocked-app': async () => ({ error: 'Focus mode is only in the desktop app.' }),
        'pick-application': async () => null,
        'save-ai-config': async () => ({ success: true }),
        'test-gemini-key': async () => ({ ok: true })
    };

    // Failures answer like the desktop app does (30/9) - it never throws:
    // lists come back empty, anything else as { error }. Throwing left
    // buttons stuck on "Saving…" / "Uploading…" when the connection dropped
    // or the server was waking up. (A 401 still reloads to the login.)
    const LIST_CHANNELS = new Set(['get-tasks', 'get-events', 'get-folders', 'get-files', 'get-files-light',
        'get-study-items', 'get-due-study-items', 'get-study-categories', 'get-task-categories', 'get-blocked-apps']);
    const NULL_CHANNELS = new Set(['get-study-stats', 'get-profile']);
    // These answer with JSON TEXT (the renderer JSON.parse()s it) - so a
    // failure is JSON text too, or the real reason became "not valid JSON".
    const JSON_TEXT_CHANNELS = new Set(['add-smart-task', 'parse-smart-event', 'generate-weekly-plan',
        'generate-study-items', 'generate-study-items-pdf']);
    async function invoke(name, ...args) {
        if (local[name]) return local[name](...args);
        await whenLoggedIn;
        try {
            const res = await api('POST', `/rpc/${encodeURIComponent(name)}`, { args });
            emit(res.events);
            return res.result;
        } catch (err) {
            const strict = args[0] && typeof args[0] === 'object' && args[0].strict;
            if (LIST_CHANNELS.has(name) && !strict) return [];
            if (NULL_CHANNELS.has(name)) return null;
            if (JSON_TEXT_CHANNELS.has(name)) return JSON.stringify({ error: err.message });
            return { error: err.message };
        }
    }

    const ipcRenderer = {
        invoke,
        send() { /* only 'toggle-blocking' (focus mode) - desktop only */ },
        on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
    };

    const electron = {
        ipcRenderer,
        clipboard: { writeText: (t) => navigator.clipboard && navigator.clipboard.writeText(String(t)).catch(() => {}) },
        shell: { openExternal: (url) => window.open(url, '_blank', 'noopener') }
    };

    // renderer.js / summary.js start with require('electron'); summary.js
    // also asks for 'katex' (loaded as a <script> in summary.html).
    window.require = function (name) {
        if (name === 'electron') return electron;
        if (name === 'katex') {
            if (window.katex) return window.katex;
            throw new Error('KaTeX not loaded');
        }
        throw new Error(`"${name}" is not available in the web version`);
    };
})();
