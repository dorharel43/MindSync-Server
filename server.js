require('dotenv').config();
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
app.set('trust proxy', 1);

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
app.use(express.json({ limit: '10mb' })); // headroom for pasted file/study-material content

// TEMP DEBUG: logs every request that actually reaches Express, with how
// long it took to respond. Remove once we've confirmed where requests are
// getting stuck - this is diagnostic, not something to ship long-term.
app.use((req, res, next) => {
  const started = Date.now();
  console.log(`→ ${req.method} ${req.originalUrl}`);
  res.on('finish', () => {
    console.log(`← ${req.method} ${req.originalUrl} ${res.statusCode} (${Date.now() - started}ms)`);
  });
  next();
});

// ==========================================
// DB connection - with resilience for a long-running server
// ==========================================
mongoose.set('strictQuery', true);

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

mongoose.connection.on('error', (err) => console.error('❌ MongoDB runtime error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('⚠️  MongoDB disconnected. Mongoose will retry automatically.'));
mongoose.connection.on('reconnected', () => console.log('✅ MongoDB reconnected.'));

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