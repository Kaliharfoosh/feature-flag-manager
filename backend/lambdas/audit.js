// ffm-audit-fn (S3): audit log, monitoring, alert rules, alerts.
// Lambda handler = backend/lambdas/audit.handler
// API Gateway routes: /api/v1/audit, /api/v1/audit/{proxy+}, /api/v1/monitoring,
// /api/v1/alert-rules, /api/v1/alerts, /api/v1/alerts/{proxy+}
module.exports.handler = require('./make-handler').makeHandler(['audit']);
