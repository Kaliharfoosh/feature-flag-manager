const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { list } = require('./controller');

const router = Router();

router.get('/', requireAuth, list);

module.exports = router;
