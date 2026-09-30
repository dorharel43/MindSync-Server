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

function mailEnabled() {
  return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM);
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
      headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: process.env.MAIL_FROM_NAME || 'MindSync', email: process.env.MAIL_FROM },
        to: [{ email: to, ...(toName ? { name: toName } : {}) }],
        subject,
        htmlContent: html,
        textContent: text
      })
    });
    if (!res.ok) {
      let detail = '';
      try { const d = await res.json(); detail = d && (d.message || d.code) ? ` (${String(d.message || d.code).slice(0, 200)})` : ''; } catch (e) { /* not JSON */ }
      throw new Error(`Brevo refused the email: HTTP ${res.status}${detail}`);
    }
    return true;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Brevo did not answer within 10 seconds.');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { mailEnabled, publicUrl, sendMail };
