const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const { list, create, detail, toggle, update, remove } = require('./controller');

const router = Router();

router.get('/', requireAuth, list);
router.post('/', requireAuth, requireCsrf, create);
router.get('/:flagId', requireAuth, detail);
router.patch('/:flagId', requireAuth, requireCsrf, update);
router.delete('/:flagId', requireAuth, requireCsrf, remove);
router.patch('/:flagId/environments/:env', requireAuth, requireCsrf, toggle);

module.exports = router;
