// POST /api/v1/evaluations: the public endpoint client apps call with an API key (S2).
// Mounted in app.js BEFORE the session middleware, so it never reads or sets a cookie and needs
// no CSRF token. The API key is the only way in.
const { Router } = require('express');
const c = require('./controller');

const router = Router();

router.post('/', c.postEvaluation);

module.exports = router;
