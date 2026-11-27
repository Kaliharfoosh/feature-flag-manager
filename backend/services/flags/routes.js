const { Router } = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const { history, recoverable, restore, list, create, detail, toggle, update, remove } = require('./controller');

const router = Router();

router.get('/', requireAuth, list);
router.post('/', requireAuth, requireCsrf, create);
router.get('/recovery', requireAuth, requireRole('admin'), recoverable);
router.get('/:flagId/history', requireAuth, history);
router.post('/:flagId/restore', requireAuth, requireRole('admin'), requireCsrf, restore);
router.get('/:flagId', requireAuth, detail);
router.patch('/:flagId', requireAuth, requireCsrf, update);
router.delete('/:flagId', requireAuth, requireCsrf, remove);
router.patch('/:flagId/environments/:env', requireAuth, requireCsrf, toggle);

module.exports = router;
