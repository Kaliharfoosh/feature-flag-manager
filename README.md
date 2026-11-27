# Feature Flag Manager

26CSCN29H Cloud Computing & Cloud Security, Group 21.

Teams use the Feature Flag Manager to turn features on and off per environment (dev, staging, prod)
and roll them out to a percentage of users without redeploying. Every change is audited. Client apps
read flag values through an API secured with environment-scoped keys.

- Live: https://feature-flag-manager-cyan.vercel.app (health check: `/api/v1/health`)
- Demo client (Acme Store): https://ffm-demo-shop.vercel.app
- How it is built: [`docs/architecture.md`](docs/architecture.md) · threats and controls: [`docs/threat-model.md`](docs/threat-model.md)

## Stack

React + Vite (frontend) · Node + Express 5 (backend) · Neon PostgreSQL (data).

The same code runs in two places:

| | Live (public) | AWS deployment |
|---|---|---|
| Runs on | Vercel: one function with all three services, behind the Vercel Firewall | Floci (AWS emulator): S3 website, API Gateway, one Lambda per service, Secrets Manager, SQS, CloudWatch, SNS |
| Built by | Git push (`vercel.json`) | `infra/floci/services/*.sh` ([README](infra/floci/services/README.md)) |

## Who owns what

| Student | Service | Folders |
|---|---|---|
| Youssef (S1) | Flag Management + shared login | `backend/services/auth`, `backend/services/flags`, `backend/middleware/auth.js`, `turnstile.js`, `frontend/src/auth`, `frontend/src/flags` |
| Habiba (S2) | Rollout Service + deployment, database and AWS Lambda / API Gateway setup | `backend/services/keys-evaluation`, `backend/db`, `backend/build-app.js`, `backend/lambdas`, `frontend/src/rollouts`, `demo-client/`, `api/`, `vercel.json`, `infra/floci/services/s2-lambdas.sh`, `infra/iam`, `tests/load`, `tests/env-check` |
| Ebrahim (S3) | Audit and Monitoring + alerts and logging | `backend/services/audit-alerts`, `backend/shared/audit.js`, `logger.js`, `metrics.js`, `backend/lambdas/alert-worker.js`, `frontend/src/audit`, `infra/floci/services/s3-audit.sh` |

Work on your own `feature/...` branch and open a pull request to `main` (CI must be green). Don't edit
another person's service folder.

## Folder map

```
api/index.js          Vercel Function entry (hands /api requests to backend/app.js)
backend/              Express API
  build-app.js        builds the app from a list of services: all three on Vercel, one per Lambda
  app.js              buildApp() with every service      server.js   local start on :3000
  lambdas/            one AWS Lambda handler per service + the alert worker
  middleware/         auth + roles, CSRF, Turnstile, request logger, 415 check, 404, error handler
  shared/             logger, audit, API key helpers, CloudWatch metrics
  services/<name>/    routes.js -> controller.js -> SQL, plus __tests__/ (Lab 4 layers)
  db/                 pool.js, migrations/*.sql, migrate.js, grants.sql, seed scripts
frontend/             React + Vite app (built to frontend/dist by Vercel)
demo-client/          Acme Store: a client app that reads its features from the API
infra/floci/          Floci (AWS) setup: docker-compose, Lambda zip builder, services/, lab8/
infra/iam/            every IAM role with its exact permissions
docs/                 architecture, threat model, API contract, test plan, load test results
evidence/             screenshots, Postman collections, test results
tests/                load (k6), security and env-check scripts
```

## Run it on your machine

1. Install Node.js 22 or newer and Git.
2. Clone the repo and open it in WebStorm.
3. Copy `.env.example` to `.env`. Ask Habiba for the database connection string privately
   (never through the repo or a chat screenshot). Generate a session secret with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. In the terminal:

```
npm install
npm --prefix frontend install
npm run migrate      # applies backend/db/migrations/*.sql once each
npm run seed         # demo teams, users and flags (needs SEED_PASSWORD in .env)
npm run dev:api      # API on http://localhost:3000
npm run dev:web      # frontend on http://localhost:5173 (proxies /api to :3000)
npm test             # Jest: unit, API and database tests
```

Open http://localhost:5173/api/v1/health and expect `{"status":"ok","db":"ok",...}`.

Other scripts: `npm run seed:demo` (the Acme Store's flags and rules), `npm run seed:key` (prints
one API key; `npm run seed:key -- prod` for another environment), `npm run build:lambda` (the zip
for Floci), `npm run check:envs` (dev, staging and prod answers side by side, keys in the
git-ignored `.env.envcheck`).

## API

All routes live under `/api/v1`. Errors always have the shape
`{ "error": { "code", "message", "requestId" } }`. The full contract is in `docs/api-contract.md`.
