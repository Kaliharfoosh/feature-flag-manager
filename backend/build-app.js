// buildApp({ services }): builds the Express app with only the routers you ask for.
//
// Why: on Vercel ONE function runs everything (backend/app.js asks for all services). On AWS
// each service gets its OWN Lambda, its own IAM role and its own database login, so a bug or a
// stolen secret in one service cannot reach the others. Each Lambda in backend/lambdas/ calls
// buildApp with just its own service. API Gateway sends each path to the right Lambda.
//
//   flags -> /api/v1/auth, /api/v1/flags, /api/v1/keys                                   (S1, ffm-flags-fn)
//   eval  -> /api/v1/evaluations, /rollouts, /rules, /preview              (S2, ffm-eval-fn)
//   audit -> /api/v1/audit, /monitoring, /alert-rules, /alerts             (S3, ffm-audit-fn)
//
// Every copy keeps the same security middleware, the health check, 404 and error handler.
// Sessions live in the shared Postgres `session` table, so a login made through ffm-flags-fn
// is also valid in ffm-eval-fn and ffm-audit-fn.
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { pool } = require('./db/pool');

const ALL_SERVICES = ['flags', 'eval', 'audit'];

function buildApp({ services = ALL_SERVICES } = {}) {
  const unknown = services.filter((name) => !ALL_SERVICES.includes(name));
  if (unknown.length || services.length === 0) {
    throw new Error(`buildApp: unknown or empty services [${unknown.join(', ')}]; use ${ALL_SERVICES.join(', ')}`);
  }
  const has = (name) => services.includes(name);

  const app = express();
  app.use(helmet());

  // Says which copy answered (flags / eval / audit), so the demo and the logs can show which
  // Lambda API Gateway picked. It names services only: nothing about versions or the server.
  const servedBy = services.join(',');
  app.use((req, res, next) => { res.set('X-Served-By', servedBy); next(); });

  // Lab 8 scale test only: each local copy of the API gets a name (ffm-task-1, -2, -3) and says
  // which copy answered, so round robin and failover can be seen. Not set on Vercel.
  const instanceId = process.env.INSTANCE_ID;
  if (instanceId) app.use((req, res, next) => { res.set('X-Instance-Id', instanceId); next(); });

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

  // S2: client apps call this with an API key. It sits BEFORE the session on purpose: no cookie,
  // no CSRF, and a client app can never pick up or use a signed-in user's session.
  if (has('eval')) app.use('/api/v1/evaluations', require('./services/keys-evaluation/evaluation-routes'));

  app.use(session({
    store: new PgStore({ pool, tableName: 'session' }), // survives cold starts; table from migration 002
    secret: process.env.SESSION_SECRET,
    name: 'ffm.sid', resave: false, saveUninitialized: false, rolling: true,
    cookie: { httpOnly: true, sameSite: 'strict', maxAge: 30 * 60 * 1000,
              secure: process.env.NODE_ENV === 'production' },
  }));

  // Health never crashes: 200 = function and DB fine, 503 = function fine but DB down (Lab 5's idea).
  // `services` says which copy answered (useful once there are three Lambdas).
  app.get('/api/v1/health', async (req, res) => {
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? 'local';
    try {
      await pool.query('select 1');
      res.json({ status: 'ok', db: 'ok', commit, services, ...(instanceId && { instanceId }) });
    } catch (err) {
      req.log.error({ err }, 'health: database unreachable');
      res.status(503).json({ status: 'degraded', db: 'down', commit, services });
    }
  });

  // Service routers
  if (has('flags')) {
    app.use('/api/v1/auth', require('./services/auth/routes'));               // S1
    app.use('/api/v1/keys', require('./services/keys/routes'));
    app.use('/api/v1/flags', require('./services/flags/routes'));             // S1
  }
  if (has('eval')) app.use('/api/v1', require('./services/keys-evaluation/routes'));  // S2
  if (has('audit')) app.use('/api/v1', require('./services/audit-alerts/routes'));    // S3

  app.use(require('./middleware/not-found')); // 404 ROUTE_NOT_FOUND
  app.use(require('./middleware/errors'));    // 400 bad JSON · 413 · 500 · { error: { code, message, requestId } }

  return app;
}

module.exports = { buildApp, ALL_SERVICES };
