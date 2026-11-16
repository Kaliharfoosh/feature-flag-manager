// Lab 7: run the SAME Express app on AWS Lambda (Floci on our PC).
// serverless-http translates the Lambda event into an Express request (req),
// and the Express response (res) back into the answer Lambda returns.
// Lambda setting: handler = backend/lambda.handler
//
// No secrets in the code or in the Lambda settings: on the first request we read ONE secret
// from Secrets Manager. It is JSON: { "DATABASE_URL": "...", "SESSION_SECRET": "..." }.
// The IAM role ffm-api-role allows reading only that one secret.
const serverless = require('serverless-http');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

let handler; // built once per Lambda instance, then reused (warm starts are fast)

module.exports.handler = async (event, context) => {
  if (!handler) {
    if (process.env.SECRET_ID) {
      const secrets = new SecretsManagerClient({}); // no keys here: the IAM role gives permission
      const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
      const values = JSON.parse(secret.SecretString);
      // Copy only the names we expect, BEFORE app.js loads db/pool.js and the session setup
      for (const name of ['DATABASE_URL', 'SESSION_SECRET']) process.env[name] = values[name];
    }
    const app = require('./app');
    app.set('trust proxy', 1); // API Gateway sits in front, like Vercel does
    handler = serverless(app, {
      // serverless-http sets Content-Length to the NUMBER 0 on a GET; Node normally gives a
      // string. Make it '0' so middleware/require-json.js sees "no body" and does not answer 415.
      request(req) {
        if (req.headers['content-length'] === 0) req.headers['content-length'] = '0';
      },
    });
  }
  return handler(event, context);
};
