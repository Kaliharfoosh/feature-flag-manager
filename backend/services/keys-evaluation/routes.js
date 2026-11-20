// Rollout Service routes for signed-in users (S2), mounted at /api/v1 AFTER the session.
// Auth is added per route, not with router.use(), because this router shares /api/v1 with other
// services: an unknown path that falls through here must still get 404 ROUTE_NOT_FOUND, not 401.
const { Router } = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const c = require('./controller');

const router = Router();

// Prod rule (API contract): any change to prod is Admin only. A Developer gets 403 FORBIDDEN,
// written as an access.denied security event by requireRole. Checked before the database is read.
const adminOnlyForProd = (req, res, next) => (
  req.params.env === 'prod' ? requireRole('admin')(req, res, next) : next()
);

router.put('/rollouts/:flagId/:env', requireAuth, requireCsrf, adminOnlyForProd, c.putRollout);

module.exports = router;
