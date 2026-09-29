#!/usr/bin/env python3
"""
Builds rpc/handlers.js from the desktop app's main.js.

    python3 tools/port-main.py ../mindsync/main.js

The web version runs the SAME app logic as the desktop app (AI prompts,
parsing Hebrew dates, the weekly planner, syllabus import...). Rather than
maintaining two copies by hand, this script takes main.js and makes only the
changes the server needs:
  - Electron / local-file / local-Google parts are cut out or replaced
    (rpc/electronShim.js, rpc/storage.js, rpc/google.js);
  - everything else is left exactly as it is.
Every edit asserts that its anchor exists exactly once, so if main.js changes
shape the script fails loudly instead of producing a broken file.
"""
import sys, re

src = open(sys.argv[1], encoding='utf-8').read().replace('\r\n', '\n')
s = src

def rep(old, new, count=1):
    global s
    n = s.count(old)
    assert n == count, f'expected {count} x, found {n}: {old[:80]!r}'
    s = s.replace(old, new)

def cut(start, end, replacement=''):
    """Remove from `start` (inclusive) up to `end` (exclusive)."""
    global s
    assert s.count(start) == 1, f'start anchor x{s.count(start)}: {start[:70]!r}'
    a = s.index(start)
    b = s.index(end, a)
    s = s[:a] + replacement + s[b:]

# ---- 1. requires --------------------------------------------------------
a = s.index("require('dotenv').config();")
b = s.index("const logger = require('./logger');") + len("const logger = require('./logger');")
s = s[:a] + """// rpc/handlers.js - GENERATED from the desktop app's main.js by
// tools/port-main.py. Don't edit by hand: change main.js and re-run the
// script (or, once the desktop app is retired, make this the source).
const path = require('path');
const { ipcMain, BrowserWindow } = require('./electronShim');
const aiProvider = require('./aiProvider');
const api = require('./apiClient');
const storage = require('./storage');
const googleSync = require('./google');
const { currentContext } = require('./context');""" + s[b:]

# ---- 2. the original file comes from server storage, not a local path ---
rep("""        if (sourcePath && fs.existsSync(sourcePath) && aiProvider.supportsVision()) {
            try {
                const buffer = fs.readFileSync(sourcePath);""",
"""        const storedPdf = sourcePath && aiProvider.supportsVision() ? await storage.readSource(sourcePath) : null;
        if (storedPdf) {
            try {
                const buffer = storedPdf;""")
rep("""        if (/\\.pdf$/i.test(sourcePath) && fs.existsSync(sourcePath) && aiProvider.supportsVision()) {
            const buffer = fs.readFileSync(sourcePath);
            if (buffer.length <= 18 * 1024 * 1024) {""",
"""        const storedSyllabus = /\\.pdf$/i.test(file.name || '') && aiProvider.supportsVision() ? await storage.readSource(sourcePath) : null;
        if (storedSyllabus) {
            const buffer = storedSyllabus;
            if (buffer.length <= 18 * 1024 * 1024) {""")
rep("""        if (!fs.existsSync(sourcePath)) {
            return JSON.stringify({ error: 'The original file has moved or been deleted. Upload it again under Materials.' });
        }

        const buffer = fs.readFileSync(sourcePath);
        const sizeMb = buffer.length / (1024 * 1024);
        console.log(`📕 generate-study-items-pdf: ${path.basename(sourcePath)} (${sizeMb.toFixed(1)} MB)`);""",
"""        const buffer = await storage.readSource(sourcePath);
        if (!buffer) {
            return JSON.stringify({ error: 'The original file isn\\'t stored on the server. Upload it again under Materials.' });
        }
        const sizeMb = buffer.length / (1024 * 1024);
        console.log(`📕 generate-study-items-pdf: ${options.sourceFile || sourcePath} (${sizeMb.toFixed(1)} MB)`);""")

# ---- 3. desktop-only sections ------------------------------------------
# reading/choosing files on the computer -> browser upload (rpc/uploads.js)
cut("// =====================================\n// File Reading", "// =====================================\n// Stats - removed")
# login lives in the browser; the diagnostic log file doesn't exist here
cut("// Lets Settings offer a \"Copy diagnostic log\"", "// =====================================\n// Profile")
# AI key settings -> managed by the server
cut("// ---- AI provider settings ----", "// =====================================\n// Google Calendar Sync Functions", """// ---- AI settings (web): the server's key; nothing for the user to set ----
ipcMain.handle('get-ai-config', async () => ({
    provider: 'gemini',
    managed: true,
    geminiModel: aiProvider.activeGeminiModel(),
    hasKey: Boolean(aiProvider.readConfig().geminiKey),
    keyPreview: '',
    active: aiProvider.resolveProvider(),
    visionAvailable: aiProvider.supportsVision()
}));

""")
# Google: the desktop OAuth flow (local port 3000, token file) -> per-user server flow
cut("// =====================================\n// Google Calendar Sync Functions", "// =====================================\n// Events",
"""// Google Calendar: per user, on the server (rpc/google.js).
const syncToGoogleCalendar = (evtData) => googleSync.insertEvent(evtData);

""")
a = s.index("async function deleteGoogleCopy(googleEventId) {")
b = s.index("\n}\n", a) + 3
s = s[:a] + """async function deleteGoogleCopy(googleEventId) {
    if (!googleEventId) return;
    try {
        await googleSync.deleteEvent(googleEventId);
    } catch (err) {
        console.error("Google Calendar delete error:", err.message);
    }
}
""" + s[b:]
# summary window -> the browser opens summary.html in a tab
cut("// =====================================\n// Summary window", "ipcMain.handle('get-file',")
# focus mode can't block apps from a web page
cut("// =====================================\n// App Blocker", "// =====================================\n// System Core")
# app lifecycle
a = s.index("function createWindow () {")
s = s[:a].rstrip() + "\n\nmodule.exports = { ipcMain };\n"

# ---- 4. uploaded originals are deleted with their file / on reset --------
rep("""ipcMain.handle('delete-file', async (event, id) => {
  try { return await api.deleteFile(id); } catch (err) { return { error: err.message }; }
});""", """ipcMain.handle('delete-file', async (event, id) => {
  try {
    // The uploaded original goes too (server storage, rpc/storage.js).
    const file = await api.getFile(id).catch(() => null);
    const result = await api.deleteFile(id);
    const ctx = currentContext();
    if (file && file.sourcePath && ctx) await storage.remove(file.sourcePath, ctx.userId).catch(() => {});
    return result;
  } catch (err) { return { error: err.message }; }
});""")
rep("""    await api.hardReset();
    return true;""", """    await api.hardReset();
    const ctx = currentContext();
    if (ctx) await storage.removeAllForUser(ctx.userId).catch(() => {});
    return true;""")

# ---- 5. nothing desktop-only may survive ---------------------------------
code_only = re.sub(r'//[^\n]*', '', s)   # comments may mention these words
for bad in [r"require\('electron'\)", r"\bdialog\.\w+\(", r"\bfs\.\w+Sync\(", r"\bapp\.getPath", r"(?<![.\w])exec\(", r"authenticateGoogle", r"callGoogleWithReauth", r"\blogger\."]:
    assert not re.search(bad, code_only), f'desktop-only code left in handlers: {bad}'

open('rpc/handlers.js', 'w', encoding='utf-8').write(s)
print('rpc/handlers.js written:', len(s.splitlines()), 'lines')

# ---- rpc/apiClient.js from the desktop apiClient.js (30/9) ----------------
# Was a hand-made copy, and drifted: "Practice anyway" and "By file" in Study
# sent ?all / ?sourceFile from the desktop copy only, so on the web they came
# back empty. Now generated too - only the header and the server address
# differ (the web logic calls the server's own routes over localhost).
import os
api_src = os.path.join(os.path.dirname(os.path.abspath(sys.argv[1])), 'apiClient.js')
a = open(api_src, encoding='utf-8').read().replace('\r\n', '\n')
old_url = "const SERVER_URL = process.env.MINDSYNC_SERVER_URL || 'https://mindsync-server-gags.onrender.com/api';"
assert a.count(old_url) == 1, 'apiClient.js: SERVER_URL line not found'
a = a.replace(old_url, """// SERVER VERSION (rpc/): the web app's logic runs inside the server, and
// calls the server's own REST routes over localhost with the user's token -
// so every rule in routes/ (validation, per-user isolation) still applies,
// and nothing is written twice.
const SERVER_URL = process.env.INTERNAL_API_URL || `http://127.0.0.1:${process.env.PORT || 5000}/api`;""")
assert a.startswith('// apiClient.js'), 'apiClient.js: unexpected first line'
a = a.replace('// apiClient.js', """// rpc/apiClient.js - GENERATED from the desktop app's apiClient.js by
// tools/port-main.py. Don't edit by hand: change apiClient.js and re-run.""", 1)
open('rpc/apiClient.js', 'w', encoding='utf-8').write(a)
print('rpc/apiClient.js written from', api_src)
