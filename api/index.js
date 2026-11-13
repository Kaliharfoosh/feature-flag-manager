// The only Vercel Function. Every /api/* request is rewritten here (see vercel.json)
// and handed to the Express app in backend/app.js.
const app = require('../backend/app');
app.set('trust proxy', 1); // Vercel supplies the client IP and terminates TLS.

module.exports = app;
