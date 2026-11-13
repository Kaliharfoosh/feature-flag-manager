// Shared pino logger (S3 extends this). Secrets are redacted before anything is written.
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'password', '*.password', 'token', '*.token', 'key', '*.key'],
    censor: '[REDACTED]',
  },
});

module.exports = logger;
