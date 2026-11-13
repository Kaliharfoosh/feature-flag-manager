const { csrfSync } = require('csrf-sync');

const { generateToken, csrfSynchronisedProtection } = csrfSync({
  errorConfig: {
    statusCode: 403,
    code: 'CSRF_INVALID',
    message: 'The CSRF token is missing or invalid.',
  },
});

module.exports = { generateToken, requireCsrf: csrfSynchronisedProtection };
