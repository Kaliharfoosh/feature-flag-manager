const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const { login, me, logout, config } = require('./controller');

const router = Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/config', config);
router.post('/login', login);
router.get('/me', requireAuth, me);
router.post('/logout', requireAuth, requireCsrf, logout);

module.exports = router;
