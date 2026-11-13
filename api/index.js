// The only Vercel Function. Every /api/* request is rewritten here (see vercel.json)
// and handed to the Express app in backend/app.js.
module.exports = require('../backend/app');
