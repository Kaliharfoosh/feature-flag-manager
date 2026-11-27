// S1: session-authenticated administration. Client apps continue to use /evaluations.
const { Router } = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const controller = require('./controller');

const router = Router();
router.use((req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  next();
});
router.get('/', requireAuth, requireRole('admin'), controller.list);
router.post('/', requireAuth, requireRole('admin'), requireCsrf, controller.create);
router.delete('/:id', requireAuth, requireRole('admin'), requireCsrf, controller.revoke);
module.exports = router;
