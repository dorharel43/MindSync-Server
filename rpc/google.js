// Google Calendar for the web version: every user connects their own Google
// account once (Settings -> Google Calendar -> Connect), and from then on the
// server adds and removes their MindSync events in it.
//
// How it works:
//   1. connectUrl(userId) - the Google sign-in page address. Google asks the
//      person to allow MindSync to manage the calendars MindSync creates.
//   2. Google sends them back to GOOGLE_REDIRECT_URI (routes/google.js) with a
//      one-time code; finishConnect() swaps it for a refresh token, creates a
//      calendar called "MindSync" in their account and saves both
//      (models/GoogleLink - the token encrypted).
//   3. insertEvent / deleteEvent - used by the app logic (rpc/handlers.js)
//      exactly like the desktop app's Google functions. They find the user
//      from the request context, get a short-lived access token from the
//      refresh token, and call the Calendar API.
//
// Plain HTTPS calls (fetch) instead of the `googleapis` package: it's four
// endpoints, and that package is very large for a small Render instance.
//
// Environment:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET - from Google Cloud Console (a "Web
//       application" OAuth client).
//   GOOGLE_REDIRECT_URI - e.g. https://<your-server>/api/google/callback (must
//       be listed on that OAuth client exactly).
//   GOOGLE_TOKEN_KEY - any long random string; encrypts the stored tokens.
//       If missing, a key derived from JWT_SECRET is used.
//   GOOGLE_TIMEZONE - default Asia/Jerusalem.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const GoogleLink = require('../models/GoogleLink');
const { currentContext } = require('./context');

const AUTH_URL = process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const REVOKE_URL = process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke';
const CALENDAR_API = process.env.GOOGLE_CALENDAR_API || 'https://www.googleapis.com/calendar/v3';
// calendar.app.created: only calendars MindSync itself creates - not the
// person's other calendars. The narrowest scope that does the job.
const SCOPES = process.env.GOOGLE_SCOPES || 'openid email https://www.googleapis.com/auth/calendar.app.created';
const TIMEZONE = process.env.GOOGLE_TIMEZONE || 'Asia/Jerusalem';
const CALENDAR_NAME = 'MindSync';
const TIMEOUT_MS = 15000;

const NOT_CONNECTED = 'Google Calendar is not connected - connect it in Settings.';
const EXPIRED = 'MindSync lost access to your Google Calendar - reconnect it in Settings.';

function isConfigured() {
    return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

// ---- encryption of stored refresh tokens (AES-256-GCM) -------------------
function key() {
    const secret = process.env.GOOGLE_TOKEN_KEY || `${process.env.JWT_SECRET}::google-tokens`;
    return crypto.createHash('sha256').update(secret).digest();
}
function encrypt(text) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
function decrypt(blob) {
    const [iv, tag, enc] = String(blob).split('.').map(s => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// ---- HTTP helpers -------------------------------------------------------
class GoogleError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
}

async function postForm(url, fields) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new GoogleError(data.error_description || data.error || `Google answered ${res.status}`, res.status, data.error);
    return data;
}

async function calendarCall(accessToken, method, path, body) {
    const res = await fetch(CALENDAR_API + path, {
        method,
        headers: { Authorization: `Bearer ${accessToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (data.error && (data.error.message || data.error)) || `Google Calendar answered ${res.status}`;
        throw new GoogleError(typeof msg === 'string' ? msg : JSON.stringify(msg), res.status);
    }
    return data;
}

// ---- connecting ---------------------------------------------------------
// state = a short-lived signed note of WHO is connecting, so the callback
// (which arrives without the app's login header) knows which account to
// attach the calendar to - and a forged callback can't pick someone else.
function connectUrl(userId, returnTo = '') {
    const state = jwt.sign({ sub: String(userId), purpose: 'google-connect', returnTo: String(returnTo).slice(0, 100) },
        process.env.JWT_SECRET, { expiresIn: '15m' });
    const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        response_type: 'code',
        scope: SCOPES,
        access_type: 'offline',       // a refresh token - keep working later
        prompt: 'consent',            // ...every time, even on a reconnect
        include_granted_scopes: 'true',
        state
    });
    return `${AUTH_URL}?${params}`;
}

function readState(state) {
    const payload = jwt.verify(state, process.env.JWT_SECRET);
    if (payload.purpose !== 'google-connect') throw new Error('wrong purpose');
    return { userId: payload.sub, returnTo: payload.returnTo || '' };
}

// The email is only shown in Settings ("Connected as ...") - read from the
// id_token Google just sent over HTTPS, so no signature check is needed.
function emailFromIdToken(idToken) {
    try {
        const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
        return payload.email || '';
    } catch { return ''; }
}

async function createCalendar(accessToken) {
    const cal = await calendarCall(accessToken, 'POST', '/calendars', { summary: CALENDAR_NAME, timeZone: TIMEZONE });
    return cal.id;
}

async function finishConnect(code, state) {
    const { userId, returnTo } = readState(state);
    const tokens = await postForm(TOKEN_URL, {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code'
    });
    if (!tokens.refresh_token) throw new GoogleError('Google did not give MindSync lasting access. Please try connecting again.');
    if (tokens.scope && !/calendar/.test(tokens.scope)) {
        // Useless without the calendar - give the access back rather than keep it.
        await postForm(REVOKE_URL, { token: tokens.refresh_token }).catch(() => {});
        throw new GoogleError('Calendar access wasn\'t allowed. Connect again and leave the calendar box ticked.', 403, 'scope');
    }

    // Reconnecting keeps using the MindSync calendar made last time.
    const existing = await GoogleLink.findOne({ userId });
    let calendarId = existing && existing.calendarId;
    if (!calendarId) calendarId = await createCalendar(tokens.access_token);

    await GoogleLink.findOneAndUpdate(
        { userId },
        { refreshTokenEnc: encrypt(tokens.refresh_token), calendarId, email: emailFromIdToken(tokens.id_token), scope: tokens.scope || '' },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    cacheToken(userId, tokens.access_token, tokens.expires_in);
    return { userId, returnTo };
}

async function status(userId) {
    if (!isConfigured()) return { configured: false, connected: false };
    const link = await GoogleLink.findOne({ userId }).lean();
    return { configured: true, connected: !!link, email: link ? link.email : '' };
}

async function disconnect(userId) {
    const link = await GoogleLink.findOne({ userId });
    if (!link) return { success: true };
    // Tell Google to cancel the access too (best effort).
    try { await postForm(REVOKE_URL, { token: decrypt(link.refreshTokenEnc) }); } catch (err) {
        console.warn('⚠️ Google revoke failed (removing the link anyway):', err.message);
    }
    await GoogleLink.deleteOne({ userId });
    accessTokens.delete(String(userId));
    return { success: true };
}

// ---- access tokens (valid ~1 hour; kept in memory) ----------------------
const accessTokens = new Map(); // userId -> { token, expiresAt }
function cacheToken(userId, token, expiresIn) {
    accessTokens.set(String(userId), { token, expiresAt: Date.now() + ((Number(expiresIn) || 3600) - 120) * 1000 });
}

async function accessFor(userId) {
    const link = await GoogleLink.findOne({ userId });
    if (!link) throw new GoogleError(NOT_CONNECTED, 400, 'not_connected');
    const cached = accessTokens.get(String(userId));
    if (cached && cached.expiresAt > Date.now()) return { link, token: cached.token };
    try {
        const t = await postForm(TOKEN_URL, {
            refresh_token: decrypt(link.refreshTokenEnc),
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token'
        });
        cacheToken(userId, t.access_token, t.expires_in);
        return { link, token: t.access_token };
    } catch (err) {
        // invalid_grant = the person removed the access in their Google
        // account, or (while the Google app is in "Testing") 7 days passed.
        if (err.code === 'invalid_grant') {
            await GoogleLink.deleteOne({ userId });
            throw new GoogleError(EXPIRED, 401, 'expired');
        }
        throw err;
    }
}

// ---- dates ---------------------------------------------------------------
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function localToday(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long'
    }).formatToParts(now).map(p => [p.type, p.value]));
    return { iso: `${parts.year}-${parts.month}-${parts.day}`, weekday: DAY_NAMES.indexOf(parts.weekday) };
}

// Wall-clock arithmetic on "YYYY-MM-DD" + "HH:MM" (no time zone involved -
// Google is told the zone separately).
function addMinutes(dateIso, time, minutes) {
    const [y, m, d] = dateIso.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d, hh, mm) + minutes * 60000);
    const pad = n => String(n).padStart(2, '0');
    return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}T${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

// Same rules as the desktop app: a one-time event on its date; a weekly one
// (no date) from its next day of the week (today counts), repeating weekly.
function toGoogleEvent(evt, now = new Date()) {
    const time = /^\d{1,2}:\d{2}$/.test(evt.time || '') ? evt.time.padStart(5, '0') : '09:00';
    let dateIso = /^\d{4}-\d{2}-\d{2}$/.test(evt.date || '') ? evt.date : null;
    const weekly = !dateIso;
    if (!dateIso) {
        const today = localToday(now);
        const target = DAY_NAMES.indexOf(evt.day);
        let add = target === -1 ? 0 : target - today.weekday;
        if (add < 0) add += 7;
        dateIso = addMinutes(today.iso, '00:00', add * 1440).slice(0, 10);
    }
    const duration = Number(evt.durationMinutes) || 60;
    return {
        summary: evt.title || 'MindSync',
        description: 'Created via MindSync',
        start: { dateTime: addMinutes(dateIso, time, 0), timeZone: TIMEZONE },
        end: { dateTime: addMinutes(dateIso, time, duration), timeZone: TIMEZONE },
        ...(weekly ? { recurrence: [weeklyRule(evt.until)] } : {})
    };
}

// Weekly, optionally ending on `until` (YYYY-MM-DD, inclusive). RFC 5545
// wants UNTIL in UTC when the start has a time zone; end of that day in UTC
// is after any class on it, and the next occurrence is a week later.
function weeklyRule(until) {
    return /^\d{4}-\d{2}-\d{2}$/.test(until || '')
        ? `RRULE:FREQ=WEEKLY;UNTIL=${until.replace(/-/g, '')}T235959Z`
        : 'RRULE:FREQ=WEEKLY';
}

// ---- used by the app logic (same interface as the desktop functions) -----
function currentUserId() {
    const ctx = currentContext();
    return ctx && ctx.userId;
}

async function insertEvent(evtData, userId = currentUserId()) {
    if (!isConfigured()) return { success: false, error: 'Google Calendar isn\'t available on this server yet.' };
    if (!userId) return { success: false, error: NOT_CONNECTED };
    try {
        const { link, token } = await accessFor(userId);
        const body = toGoogleEvent(evtData);
        let calendarId = link.calendarId;
        if (!calendarId) calendarId = await createCalendar(token);
        let created;
        try {
            created = await calendarCall(token, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
        } catch (err) {
            // The person deleted the MindSync calendar in Google: make a new one.
            if (err.status !== 404 && err.status !== 410) throw err;
            calendarId = await createCalendar(token);
            created = await calendarCall(token, 'POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
        }
        if (calendarId !== link.calendarId) await GoogleLink.updateOne({ userId }, { calendarId });
        return { success: true, eventId: created.id, link: created.htmlLink };
    } catch (err) {
        console.error('❌ Google Calendar insert failed:', err.message);
        return { success: false, error: err.message };
    }
}

// Removing is best effort: already gone (404/410) counts as done.
async function deleteEvent(googleEventId, userId = currentUserId()) {
    if (!googleEventId || !userId || !isConfigured()) return;
    let access;
    try { access = await accessFor(userId); } catch { return; }
    const { link, token } = access;
    if (!link.calendarId) return;
    try {
        await calendarCall(token, 'DELETE', `/calendars/${encodeURIComponent(link.calendarId)}/events/${encodeURIComponent(googleEventId)}`);
    } catch (err) {
        if (err.status !== 404 && err.status !== 410) throw err;
    }
}

module.exports = {
    isConfigured, connectUrl, finishConnect, status, disconnect,
    insertEvent, deleteEvent,
    // for tests
    _internal: { encrypt, decrypt, toGoogleEvent, localToday }
};
