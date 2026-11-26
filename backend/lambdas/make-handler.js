// Lab 7: run the Express app on AWS Lambda (Floci on our PC). Shared by every Lambda in this
// folder: each one passes its own list of services, so it only mounts its own routes.
// serverless-http translates the Lambda event into an Express request (req),
// and the Express response (res) back into the answer Lambda returns.
//
// No secrets in the code or in the Lambda settings: on the first request we read ONE secret
// from Secrets Manager, named by the SECRET_ID setting. It is JSON:
//   { "DATABASE_URL": "...", "SESSION_SECRET": "..." }
// Each Lambda has its own secret (ffm/flags-db, ffm/eval-db, ffm/audit-db) holding its own
// database login, and its IAM role may read only that one secret.
const serverless = require('serverless-http');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

function makeHandler(services) {
  let handler; // built once per Lambda instance, then reused (warm starts are fast)

  return async (event, context) => {
    if (!handler) {
      if (process.env.SECRET_ID) {
        const secrets = new SecretsManagerClient({}); // no keys here: the IAM role gives permission
        const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ID }));
        const values = JSON.parse(secret.SecretString);
        // Copy only the names we expect, BEFORE build-app.js loads db/pool.js and the session setup
        for (const name of ['DATABASE_URL', 'SESSION_SECRET']) process.env[name] = values[name];
      }
      const { buildApp } = require('../build-app');
      const app = buildApp({ services });
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
}

module.exports = { makeHandler };
