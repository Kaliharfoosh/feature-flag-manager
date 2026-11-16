// Express app, shared by backend/server.js (your machine) and api/index.js (Vercel).
// Same split as Lab 7: app.js builds the app and never calls listen().
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { pool } = require('./db/pool');

const app = express();
app.use(helmet());

// Lab 5/7: CORS. Only switched on where the frontend lives on a different address
// (Floci: the S3 website). Allowed origins come from CORS_ORIGINS (comma-separated).
// On Vercel CORS_ORIGINS is not set: frontend and API share one address, so no CORS is needed
// and every other site stays blocked by the browser.
if (process.env.CORS_ORIGINS) {
  const cors = require('cors');
  const allowedOrigins = process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim());
  app.use(cors({ origin: allowedOrigins, credentials: true })); // credentials: the login cookie
}
app.use(require('./middleware/request-logger')); // time, method, path, requestId: never the body
app.use(require('./middleware/require-json'));   // 415 when a body is not JSON (Lab 4)
app.use(express.json({ limit: '10kb' }));
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }), // survives cold starts; table from migration 002
  secret: process.env.SESSION_SECRET,
  name: 'ffm.sid', resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 30 * 60 * 1000,
            secure: process.env.NODE_ENV === 'production' },
}));

// Health never crashes: 200 = function and DB fine, 503 = function fine but DB down (Lab 5's idea).
app.get('/api/v1/health', async (req, res) => {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? 'local';
  try {
    await pool.query('select 1');
    res.json({ status: 'ok', db: 'ok', commit });
  } catch (err) {
    req.log.error({ err }, 'health: database unreachable');
    res.status(503).json({ status: 'degraded', db: 'down', commit });
  }
});

// Service routers. Each owner uncomments their line when routes.js exists.
app.use('/api/v1/auth', require('./services/auth/routes'));
app.use('/api/v1/flags', require('./services/flags/routes'));
// app.use('/api/v1', require('./services/keys-evaluation/routes'));       // S2
app.use('/api/v1', require('./services/audit-alerts/routes'));            // S3

app.use(require('./middleware/not-found')); // 404 ROUTE_NOT_FOUND
app.use(require('./middleware/errors'));    // 400 bad JSON · 413 · 500 · { error: { code, message, requestId } }

module.exports = app;
