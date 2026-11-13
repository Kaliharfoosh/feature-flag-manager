// Gives every request an id and logs one line per request: time, method, path, status, duration.
// Never the body (Lab 4 / Lab 7 rule), and the query string is dropped too.
const crypto = require('node:crypto');
const logger = require('../shared/logger');

module.exports = (req, res, next) => {
  req.id = crypto.randomUUID();
  req.log = logger.child({ requestId: req.id });
  res.setHeader('X-Request-Id', req.id);
  const started = Date.now();
  res.on('finish', () => {
    req.log.info({
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - started,
    }, 'request');
  });
  next();
};
