const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const { list, create } = require('./controller');

const router = Router();

router.get('/', requireAuth, list);
router.post('/', requireAuth, requireCsrf, create);

module.exports = router;
