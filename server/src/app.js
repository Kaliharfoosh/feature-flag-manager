const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const { pool } = require('./db');

const app = express();
app.set('trust proxy', 1); // Vercel terminates TLS in front of us
app.use(helmet());
app.use(express.json({ limit: '10kb' }));
app.use(session({
  store: new PgStore({ pool, tableName: 'session' }), // survives cold starts
  secret: process.env.SESSION_SECRET,
  name: 'ffm.sid', resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: 30 * 60 * 1000,
            secure: process.env.NODE_ENV === 'production' },
}));

app.get('/api/v1/health', async (req, res) => {
  await pool.query('select 1');
  res.json({ status: 'ok', commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local' });
});
// app.use('/api/v1/auth', require('./shared/auth.routes'));                  // S1
// app.use('/api/v1/flags', require('./services/flags/routes'));             // S1
// app.use('/api/v1', require('./services/keys-evaluation/routes'));         // S2
// app.use('/api/v1', require('./services/audit-alerts/routes'));            // S3
// app.use(require('./shared/errors'));   // { error: { code, message, requestId } }

module.exports = app;
