// ffm-eval-fn (S2): evaluations (API key), rollouts, rules, preview.
// Lambda handler = backend/lambdas/eval.handler
// API Gateway routes: /api/v1/evaluations, /api/v1/evaluations/batch, /api/v1/rollouts/{proxy+},
// /api/v1/rules/{proxy+}, /api/v1/preview
module.exports.handler = require('./make-handler').makeHandler(['eval']);
