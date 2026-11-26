// Express app with ALL services, shared by backend/server.js (your machine) and api/index.js (Vercel).
// Same split as Lab 7: the app is built here and never calls listen().
// The real setup lives in build-app.js. On AWS each Lambda in backend/lambdas/ builds its own
// smaller copy with only its own service.
const { buildApp } = require('./build-app');

module.exports = buildApp();
