// Audit and Monitoring routes (S3), mounted at /api/v1. Auth is added per route, not with
// router.use(), because this router shares /api/v1 with other services: an unknown path that
// falls through here must still get 404 ROUTE_NOT_FOUND, not 401.
const { Router } = require('express');
const { requireAuth, requireRole } = require('../../middleware/auth');
const { requireCsrf } = require('../../middleware/csrf');
const c = require('./controller');

const router = Router();
const admin = [requireAuth, requireRole('admin')];

// Audit data and shown-once values must never sit in a browser or proxy cache.
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

router.get('/audit', noStore, requireAuth, c.listAudit);
router.get('/audit/summary', noStore, requireAuth, c.auditSummary);
router.get('/audit/export.csv', noStore, ...admin, c.exportAudit);
router.get('/monitoring', noStore, ...admin, c.monitoring);
router.get('/alert-rules', noStore, ...admin, c.getAlertRules);
router.put('/alert-rules', noStore, ...admin, requireCsrf, c.putAlertRules);
router.get('/alerts', noStore, ...admin, c.listAlerts);
router.post('/alerts/:auditId/github-issue', noStore, ...admin, requireCsrf, c.createGithubIssue);

module.exports = router;
