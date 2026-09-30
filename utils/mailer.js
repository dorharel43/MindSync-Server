// Sending email (30/9) - through Brevo's HTTP API.
//
// Why not plain SMTP: Render's free plan blocks the SMTP ports (25, 465,
// 587), so the usual "send through a mail server" never connects there.
// An HTTPS request to Brevo works on every plan.
//
// Render env:
//   BREVO_API_KEY   the key from Brevo > Settings > SMTP & API > API keys
//   MAIL_FROM       the sender address verified in Brevo (Settings > Senders)
//   MAIL_FROM_NAME  optional, default "MindSync"
// Without BREVO_API_KEY + MAIL_FROM nothing is sent and mailEnabled() is
// false - the app hides "Forgot password?" and skips the welcome email.
//
// The key never reaches the browser, a log line or an error message.

const BASE = () => (process.env.BREVO_BASE_URL || 'https://api.brevo.com/v3').replace(/\/$/, '');
const TIMEOUT_MS = 10000;

// MAIL_FROM as typed into Render (30/9): spaces or a line break around it,
// quotes, or the "MindSync <x@gmail.com>" form all made Brevo answer "valid
// sender email required". Take just the address.
// Invisible characters that come along with copy-paste (right-to-left
// marks from a Hebrew page, zero-width spaces, a non-breaking space) look
// like nothing on screen but make the address invalid.
const INVISIBLE = /[\u00A0\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
function senderAddress() {
  let v = String(process.env.MAIL_FROM || '').replace(INVISIBLE, '').trim().replace(/^["']+|["']+$/g, '').trim();
  const angle = /<([^<>]+)>/.exec(v);
  if (angle) v = angle[1].trim();
  v = v.replace(/^mailto:/i, '').trim();
  return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v) ? v : '';
}

function mailEnabled() {
  return !!(String(process.env.BREVO_API_KEY || '').trim() && senderAddress());
}

// Said once at start-up, so a mistyped setting shows in the Render log.
if (process.env.MAIL_FROM && !senderAddress()) {
  console.warn('✉️ MAIL_FROM on Render is not an email address - set it to just the address (e.g. mindsync.app@gmail.com). Email is off until then.');
}
if (process.env.MAIL_FROM && INVISIBLE.test(process.env.MAIL_FROM)) {
  console.warn('✉️ MAIL_FROM had invisible characters in it (from copy-paste) - they are ignored. Better: type the address again on Render.');
}

// Start-up check (30/9): asks Brevo which senders are verified and says in
// the log whether MAIL_FROM is one of them - the usual reason Brevo refuses
// with "valid sender email required". Only the app's own sender addresses
// are written to the log, never the key.
async function checkSetup() {
  if (!mailEnabled()) return;
  const from = senderAddress();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE()}/senders`, { signal: ctrl.signal, headers: { 'api-key': String(process.env.BREVO_API_KEY).trim(), accept: 'application/json' } });
    if (res.status === 401) return console.warn('✉️ Brevo says the BREVO_API_KEY is not valid - create an API key (it starts with xkeysib-) under SMTP & API > API Keys.');
    if (!res.ok) return console.warn(`✉️ Brevo sender check: HTTP ${res.status}`);
    const data = await res.json();
    const senders = (data && data.senders) || [];
    const mine = senders.find(x => String(x.email || '').toLowerCase() === from.toLowerCase());
    if (mine && mine.active !== false) console.log(`✉️ Email is on: sending as ${mine.name || 'MindSync'} <${from}> (a verified Brevo sender).`);
    else if (mine) console.warn(`✉️ ${from} is a Brevo sender but NOT verified yet - open the code Brevo emailed to it, or verify it under Senders.`);
    else console.warn(`✉️ MAIL_FROM (${from}) is not one of your Brevo senders. Senders in Brevo: ${senders.map(x => `${x.email}${x.active === false ? ' (not verified)' : ''}`).join(', ') || 'none'}. Set MAIL_FROM to a verified one.`);
  } catch (err) {
    console.warn('✉️ Brevo sender check failed:', err.name === 'AbortError' ? 'no answer' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

// The address links in emails point to. NEVER taken from the request's Host
// header: anyone can send a request with a made-up Host, and a reset email
// would then carry a link to their site ("password reset poisoning").
// Render sets RENDER_EXTERNAL_URL by itself; PUBLIC_URL overrides it (e.g.
// once there is an own domain).
function publicUrl() {
  const url = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 5000}`;
  return url.replace(/\/$/, '');
}

// { to, toName?, subject, html, text } -> true when Brevo accepted it.
// Throws with a plain message when it didn't (callers log it; the person
// sees a generic "couldn't send").
async function sendMail({ to, toName, subject, html, text }) {
  if (!mailEnabled()) throw new Error('Email is not set up on this server.');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE()}/smtp/email`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'api-key': String(process.env.BREVO_API_KEY).trim(), 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: String(process.env.MAIL_FROM_NAME || 'MindSync').trim() || 'MindSync', email: senderAddress() },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject,
        htmlContent: html,
        textContent: text
      })
    });
    if (!res.ok) {
      let detail = '';
      try { const d = await res.json(); detail = d && (d.message || d.code) ? ` (${String(d.message || d.code).slice(0, 200)})` : ''; } catch (e) { /* not JSON */ }
      const hint = /sender/i.test(detail) ? ` - sent as ${JSON.stringify(senderAddress())}; it must be a verified sender in Brevo` : '';
      throw new Error(`Brevo refused the email: HTTP ${res.status}${detail}${hint}`);
    }
    return true;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Brevo did not answer within 10 seconds.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { mailEnabled, publicUrl, sendMail, checkSetup, senderAddress };
