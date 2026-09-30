require('dotenv').config();
// The app's "today", "tomorrow" and the planner's hours are Israel time. The
// server (Render) runs in UTC, so between midnight and 03:00 a task without
// a date got yesterday's date. Set before anything reads the clock.
if (!process.env.TZ) process.env.TZ = 'Asia/Jerusalem';
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const { notFound, errorHandler } = require('./middleware/errorHandler');
const ApiError = require('./middleware/ApiError');

// ==========================================
// Startup env validation - fail fast and loud
// ==========================================
// AUTH: JWT_SECRET added - without it every token issued/verified in
// routes/auth.js and middleware/auth.js would be signed with `undefined`,
// which "works" until the process restarts with a different `undefined`...
// except it's always the same undefined, so it would actually silently work
// and be a real, unrotatable secret nobody chose. Fail loudly instead.
const REQUIRED_ENV_VARS = ['MONGO_URI', 'JWT_SECRET'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (missingEnvVars.length > 0) {
  console.error(`❌ Missing required environment variable(s): ${missingEnvVars.join(', ')}`);
  console.error('   Create a .env file (see .env.example) before starting the server.');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000; // Render (and most hosts) inject PORT - never hardcode 5000 for prod

// Needed on Render/Heroku/etc. so Express reads the real client info from
// the X-Forwarded-* headers the platform's proxy sets, instead of seeing
// every request as coming from the proxy itself.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS) || 1);   // hops of proxies in front (Render: check the start-up log line "client address check")

// ==========================================
// Middlewares
// ==========================================
// ALLOWED_ORIGINS: comma-separated list, e.g. "https://mindsync.app,http://localhost:5173".
// Leave unset in local dev to allow any origin. The Electron app's own
// requests come from the main (Node) process, not a browser context, so
// they never send an Origin header and are unaffected by this either way -
// this setting only matters once something browser-based calls the API.
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

app.use(
  cors(
    allowedOrigins
      ? {
          origin: (origin, callback) => {
            if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
            callback(new ApiError(403, `Origin ${origin} is not allowed by CORS`));
          },
        }
      : {} // no ALLOWED_ORIGINS set -> permissive default, fine for local dev
  )
);
// ==========================================
// Security headers (30/9 security pass)
// ==========================================
// No inline scripts anywhere in the app (the Google result page gets a
// per-response nonce), so a script that somehow got into the page can't
// run - the login token lives in localStorage on this origin. Frames are
// refused (clickjacking), MIME sniffing is off.
app.disable('x-powered-by');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",   // style="" attributes are used throughout
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Content-Security-Policy', CSP);
  next();
});

// ==========================================
// Body size (30/9): small by default. A few routes carry real text (a
// file's content, questions in bulk, the app's RPC calls) and get more -
// but only with a valid-looking login, so an anonymous visitor can't make
// the server read megabytes of JSON.
// ==========================================
const jwt = require('jsonwebtoken');
const smallJson = express.json({ limit: '100kb' });
const bigJson = express.json({ limit: '3mb' });
const BIG_BODY = /^\/api\/(rpc|files|study\/bulk)(\/|$)/;
app.use((req, res, next) => {
  if (req.path.startsWith('/api/uploads')) return next();   // raw file bytes, its own parser + limit
  if (BIG_BODY.test(req.path)) {
    const [scheme, token] = String(req.headers.authorization || '').split(' ');
    let ok = false;
    try { ok = scheme === 'Bearer' && !!jwt.verify(token, process.env.JWT_SECRET); } catch (e) { ok = false; }
    return (ok ? bigJson : smallJson)(req, res, next);
  }
  smallJson(req, res, next);
});
// No body / not JSON -> an empty object, so routes don't crash reading it.
app.use((req, res, next) => {
  if (req.body === undefined && !req.path.startsWith('/api/uploads')) req.body = {};
  next();
});

// Request log: method, path (never the query string - it can carry
// one-time codes), status and time.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

// ==========================================
// DB connection - with resilience for a long-running server
// ==========================================
// 'throw', not true (30/9): with true, a filter on a field that isn't in
// the schema is silently DROPPED - that's how Settings.findOne({ userId })
// became findOne({}) and every user shared one list. Now it's an error.
mongoose.set('strictQuery', 'throw');

async function connectDB() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB Atlas!');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
    process.exit(1);
  }
}
connectDB();

// Housekeeping (30/9), a minute after start and then daily: stored files no
// file record points to, and indexes brought in line with the models (the
// per-user Settings index became unique; an old non-unique one with the
// same name would otherwise stay).
async function housekeeping() {
  try {
    const n = await require('./rpc/storage').sweepOrphans();
    if (n) console.log(`🧹 Removed ${n} stored file(s) nothing pointed to.`);
  } catch (err) { console.warn('housekeeping (files):', err.message); }
  try { await require('./models/Settings').syncIndexes(); } catch (err) { console.warn('housekeeping (indexes):', err.message); }
}
mongoose.connection.once('open', () => {
  setTimeout(housekeeping, 60 * 1000).unref();
  setInterval(housekeeping, 24 * 60 * 60 * 1000).unref();
});

mongoose.connection.on('error', (err) => console.error('❌ MongoDB runtime error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected. Mongoose will retry automatically.'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected.'));

// ==========================================
// Web app (browser version) - served from web/ at /app/
// ==========================================
// A browser opening the bare address lands on the app; API clients (the
// desktop app's health check) still get the JSON below.
const path = require('path');
const fs = require('fs');
// Public pages (Google requires both to verify the Calendar connection):
//   /         the home page - what MindSync is, link to the app and the policy
//   /privacy  the privacy policy; CONTACT_EMAIL fills in how to reach you
const WEB_DIR = path.join(__dirname, 'web');
app.get('/', (req, res, next) => {
  if (!(req.headers.accept || '').includes('text/html')) return next(); // API clients: health JSON below
  const home = path.join(WEB_DIR, 'home.html');
  if (fs.existsSync(home)) return res.sendFile(home);
  res.redirect('/app/');
});
const PRIVACY_UPDATED = '30 September 2026';
// The owner's beta numbers (30/9). The page itself is public but empty - the
// data behind it (/api/admin/beta) is only for the emails in ADMIN_EMAILS.
app.get('/admin', (req, res, next) => {
  const page = path.join(WEB_DIR, 'admin.html');
  if (fs.existsSync(page)) return res.sendFile(page);
  next();
});

// Forgot password (30/9): ask for the email, or - from the emailed link -
// choose a new password. See routes/auth.js forgot-password/reset-password.
app.get('/reset-password', (req, res, next) => {
  const page = path.join(WEB_DIR, 'reset-password.html');
  if (fs.existsSync(page)) return res.sendFile(page);
  next();
});

app.get('/privacy', (req, res, next) => {
  fs.readFile(path.join(WEB_DIR, 'privacy.html'), 'utf8', (err, html) => {
    if (err) return next();
    const email = (process.env.CONTACT_EMAIL || '').trim();
    const contact = email
      ? `Questions or requests about your data: <a href="mailto:${encodeURI(email)}">${email.replace(/[<>&"]/g, '')}</a>.`
      : 'Questions or requests about your data: use Settings → Send feedback in the app.';
    res.type('html').send(html.replace('{{CONTACT}}', contact).replace('{{UPDATED}}', PRIVACY_UPDATED));
  });
});
app.use('/app', express.static(path.join(__dirname, 'web'), { extensions: ['html'] }));
// KaTeX (formulas in summaries) straight from node_modules.
app.use('/app/vendor/katex', express.static(path.join(path.dirname(require.resolve('katex/package.json')), 'dist')));

// ==========================================
// Health check
// ==========================================
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'MindSync Server',
    dbState: mongoose.connection.readyState, // 1 = connected
  });
});

// ==========================================
// Routes - all pointing at routes/, none at models/
// ==========================================
// AUTH: /api/auth MUST be registered here, with the other routes - not
// after notFound/errorHandler. Express matches middleware in registration
// order, so anything after notFound() can never be reached; every request
// to /api/auth/* would have hit the 404 handler first and never reached
// routes/auth.js at all. Register/login would have been permanently broken.
//
// /api/profile is gone - name/degree moved onto User (see routes/auth.js's
// GET/PUT /me), so there's one less singleton document and one less route
// that needed to learn about userId.
app.use('/api/auth', require('./routes/auth'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/events', require('./routes/events'));
app.use('/api/folders', require('./routes/folders'));
app.use('/api/files', require('./routes/files'));
// /api/stats was removed with XP, levels and the streak.
app.use('/api/settings', require('./routes/settings'));
app.use('/api/study', require('./routes/study'));
app.use('/api/admin', require('./routes/admin'));
// Web version: the app's logic (AI, parsing, planner...) and file uploads.
app.use('/api/rpc', require('./rpc'));
app.use('/api/uploads', require('./rpc/uploads'));
app.use('/api/feedback', require('./routes/feedback'));
app.use('/api/google', require('./routes/google'));

// ==========================================
// Error handling - must be registered last, in this order
// ==========================================
app.use(notFound);
app.use(errorHandler);

// ==========================================
// Process-level safety nets
// ==========================================
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
  process.exit(1);
});

app.listen(PORT, () => {
  console.log(`🚀 Server is running on http://localhost:${PORT}`);
});

module.exports = app;