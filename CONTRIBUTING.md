# Contributing

Thanks for working on the Feature Flag Manager. This guide explains who owns what and how changes reach `main`.

## Who owns what

Each student owns one service. Don't edit another person's service folder; open an issue or ask them instead.

| Student | Service | Folders |
|---|---|---|
| Youssef (S1) | Flag Management + shared login | `backend/services/auth`, `backend/services/flags`, `backend/services/keys`, `backend/middleware/auth.js`, `turnstile.js`, `frontend/src/auth`, `frontend/src/flags`, `frontend/src/keys` |
| Habiba (S2) | Rollout Service + deployment, database and AWS Lambda / API Gateway setup | `backend/services/keys-evaluation`, `backend/db`, `backend/build-app.js`, `backend/lambdas`, `frontend/src/rollouts`, `demo-client/`, `api/`, `vercel.json`, `infra/floci/services/s2-lambdas.sh`, `infra/iam`, `tests/load`, `tests/env-check` |
| Ebrahim (S3) | Audit and Monitoring + alerts and logging | `backend/services/audit-alerts`, `backend/shared/audit.js`, `logger.js`, `metrics.js`, `backend/lambdas/alert-worker.js`, `frontend/src/audit`, `infra/floci/services/s3-audit.sh` |

`docs/api-contract.md` is shared: change it only through a pull request that all three owners approve.

## Workflow

1. Update your local `main`: `git switch main && git pull`.
2. Create a branch: `feature/...`, `fix/...`, `docs/...` or `test/...`.
3. Make your change, with tests where it changes behaviour.
4. Run `npm test` locally (and `npm --prefix frontend run build` if you touched the frontend).
5. Push the branch and open a pull request to `main`. Fill in the template.
6. CI must be green (`test` and `secrets`) before merging. `main` blocks direct and force pushes.

## Rules

- **Never commit secrets.** `.env` files are git-ignored; only `.env.example` (names, no values) is tracked. gitleaks scans the full history on every pull request.
- **Database changes** go in a new numbered file in `backend/db/migrations/`; never edit a migration that has already run.
- **API changes** must match `docs/api-contract.md`, including the error shape `{ "error": { "code", "message", "requestId" } }`.
- Keep commit messages short and in the imperative ("Add batch evaluation endpoint").
