const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const { login, me, logout } = require('./controller');

const router = Router();

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/login', login);
router.get('/me', requireAuth, me);
router.post('/logout', requireAuth, requireCsrf, logout);

module.exports = router;
