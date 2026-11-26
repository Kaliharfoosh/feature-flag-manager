// ffm-flags-fn (S1): sign-in and flags.  Lambda handler = backend/lambdas/flags.handler
// API Gateway routes: /api/v1/auth/{proxy+}, /api/v1/flags, /api/v1/flags/{proxy+}
module.exports.handler = require('./make-handler').makeHandler(['flags']);
