# Feature Flag Manager

26CSCN29H Cloud Computing & Cloud Security, Group 21.

Teams use the Feature Flag Manager to turn features on and off per environment (dev, staging, prod)
and roll them out to a percentage of users without redeploying. Every change is audited. Client apps
read flag values through an API secured with environment-scoped keys.

Live: https://feature-flag-manager-cyan.vercel.app (health check: `/api/v1/health`)

## Stack

React + Vite (frontend) · Node + Express 5 on one Vercel Function (backend) · Neon PostgreSQL (data).
One Vercel project, one origin: `vercel.json` serves `frontend/dist` and sends `/api/*` to `api/index.js`.

## Who owns what

| Student | Service | Folders |
|---|---|---|
| Youssef (S1) | Flag Management + shared login | `backend/services/auth`, `backend/services/flags`, `backend/middleware/auth*`, `frontend/src/auth`, `frontend/src/pages/flags` |
| Habiba (S2) | Rollout Service + deployment and database | `backend/services/keys-evaluation`, `backend/db`, `frontend/src/pages/rollout`, `api/`, `vercel.json` |
| Ebrahim (S3) | Audit and Monitoring + logging and integration tests | `backend/services/audit-alerts`, `backend/shared/audit.js`, `backend/shared/logger.js`, `frontend/src/pages/audit` |

Work on your own `feature/...` branch and open a pull request to `main`. Don't edit another person's service folder.

## Folder map

```
api/index.js        Vercel Function entry (hands /api requests to backend/app.js)
backend/            Express API
  app.js            app wiring (no listen)        server.js   local start on :3000
  middleware/       request logger, 415 check, 404, central error handler, auth (S1)
  shared/           logger, validate, audit helpers
  services/<name>/  routes.js -> controller.js -> service.js, plus __tests__/  (Lab 4 layers)
  db/               pool.js, migrations/*.sql, migrate.js, grants.sql, seed.js
frontend/           React + Vite app (built to frontend/dist by Vercel)
docs/               architecture, API contract, test plan, threat model
evidence/           screenshots, Postman collections, test results
tests/http/         WebStorm HTTP Client request files
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
```

Open http://localhost:5173/api/v1/health and expect `{"status":"ok","db":"ok",...}`.

## API

All routes live under `/api/v1`. Errors always have the shape
`{ "error": { "code", "message", "requestId" } }`. The full contract is in `docs/api-contract.md`.
