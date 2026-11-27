Rollout Service (S2, Habiba). The `/keys` routes belong to S1 (Youssef); this service only checks keys inside `/evaluations`.

| File | What it does |
|---|---|
| `routes.js` | Signed-in routes, mounted at `/api/v1` after the session: rollouts, rules, preview |
| `evaluation-routes.js` | `POST /api/v1/evaluations` and `/evaluations/batch`, mounted in `build-app.js` **before** the session (no cookie, no CSRF) |
| `controller.js` | Validates with `schema.js`, calls the files below, picks the status code |
| `schema.js` | zod schemas (strict: unknown fields are a 400) |
| `rollouts.js` | `createDefaults()` for S1, `getRollouts()`, `setPercentage()` (version check, audit row) |
| `rules.js` | Allow/block list: list, add (409 on a duplicate), find, remove; writes are audited |
| `evaluations.js` | SQL for `/evaluations`: key lookup by hash, flag settings, per-key rate limit, `lastUsedAt` |
| `evaluate.js` | Pure logic: `bucket()` and `evaluate()`; no database |

Shared with S1: `backend/shared/api-keys.js` has `newKey(env)` (use it in `/keys`) and `hashKey(raw)`.

## Done

- `PUT /rollouts/:flagId/:env` `{ percentage, version }`: 200, 400, 401, 403 (Developer on prod, logged as `access.denied`), 403 CSRF, 404 (other team), 409 `STALE_VERSION`. Audited as `rollout.updated`; a prod change raises the `prod_change` alert.
- `POST /evaluations` `Authorization: Bearer ffm_stg_…` `{ flagKey, userId }`: 200, 400 (also when the body sends `env`, ST-06), 401 (missing, unknown or revoked key, ST-07), 404, 429 `RATE_LIMITED`, 503 `DB_UNAVAILABLE`.
- Rate limit: 120 requests per minute per key, counted in `api_key_usage` (migration 003) so every serverless instance shares one count. A 429 carries `Retry-After` (seconds). The first refusal in a minute is logged as `rate_limit.hit` (counted on the monitoring card); later ones are not, so a flood cannot flood the audit log.
- Demo key: `npm run seed:key` prints a new staging key for "Acme Web" once (only the hash is stored).
- `GET /rollouts/:flagId`: all three envs; a missing row reads as 0%, version 1 (what PUT creates). 401, 404.
- `GET /rollouts/:flagId/:env/rules`: `{ items: [{ id, userId, kind, createdAt }] }`. 400 (bad env), 401, 404. Developers may read prod.
- `POST /rollouts/:flagId/:env/rules` `{ userId, kind }`: 201, 400, 401, 403 (Developer on prod), 403 CSRF, 404, 409 `CONFLICT`. Audited as `rule.added`.
- `DELETE /rules/:ruleId`: 204, 401, 403 (Developer on a prod rule; the rule is read first to learn its env), 403 CSRF, 404. Audited as `rule.removed`.
- `POST /preview` `{ flagKey, env, userId }`: `{ …, enabled, reason, bucket }`. Same SQL and `evaluate()` as `/evaluations`, so it can never disagree. Writes nothing. 400, 401, 403 (Developer on prod), 403 CSRF, 404.
- `POST /evaluations/batch` `{ userId, flagKeys }` (1–50 keys): every flag in one query, counted as **one** request for the rate limit. Used by the Acme Store.
- Rollout page in the frontend (`frontend/src/rollouts/`): percentages per environment, allow/block lists, preview. Prod is locked for Developers there and refused by the API.
- Demo client `demo-client/` (Acme Store): 28 features read live with a staging key; see its README.
- On AWS (Floci) this service runs as its own Lambda `ffm-eval-fn` behind API Gateway, with its own secret and IAM role (`infra/floci/services/README.md`).

## For S1: `rollouts.createDefaults(tx, flagId)`

Call it in the create-flag service, on the same transaction client, right after inserting the flag:

```js
const rollouts = require('../keys-evaluation/rollouts');

await client.query('BEGIN');
const { rows: [flag] } = await client.query('INSERT INTO flags (...) VALUES (...) RETURNING id', [...]);
const environments = await rollouts.createDefaults(client, flag.id);
// environments = { dev: { percentage: 0, version: 1 }, staging: {...}, prod: {...} }
await audit.record(client, req, { action: 'flag.created', ... });
await client.query('COMMIT');
```

It inserts the three `flag_environments` rows (off) and the three `rollouts` rows (0%, version 1).
You don't need to insert `flag_environments` yourself; if you do, your rows are kept as they are.
If it throws, roll back the whole transaction so no flag is left without its rollouts.
