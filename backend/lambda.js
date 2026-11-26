// Lab 7: the original single Lambda with EVERY service (ffm-api). Lambda handler = backend/lambda.handler
// Kept so the Lab 7 setup still works. The per-service Lambdas are in backend/lambdas/.
// The IAM role ffm-api-role allows reading only the one secret named by SECRET_ID.
module.exports.handler = require('./lambdas/make-handler').makeHandler(['flags', 'eval', 'audit']);
