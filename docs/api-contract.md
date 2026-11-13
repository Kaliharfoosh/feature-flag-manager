# API Contract: Feature Flag Manager

Written before the routes, as in Lab 3. Both the frontend and the backend are built against this
file. Change it only through a pull request that all three owners approve.

## Conventions

| Rule | Detail |
|---|---|
| Base path | Every route lives under `/api/v1`. Example: `GET /api/v1/flags`. |
| Format | Requests and responses are JSON (`Content-Type: application/json`). A body with any other type gets `415`. |
| Who may call | **Admin**, **Developer** (both need a session cookie), **Scoped key** (a client app with `Authorization: Bearer <api key>`), **Public** (nobody signed in). |
| Session | `POST /auth/login` sets the cookie `ffm.sid` (HttpOnly, Secure, SameSite=Strict, 30 minutes, sliding). |
| CSRF | Every write (POST, PUT, PATCH, DELETE) made with the cookie must send the header `X-CSRF-Token` with the value from `GET /auth/me`. Missing or wrong token: `403 CSRF_INVALID`. |
| Ownership | Everything belongs to the signed-in user's team. An id from another team answers `404`, never `403`, so the id's existence is not revealed. |
| Prod rule | Any change to the `prod` environment (toggle, rollout, rules) is Admin only. A Developer gets `403 FORBIDDEN`. |
| Versions | Flags, environment toggles and rollouts carry an integer `version`. Send the version you last read; if the row changed in between you get `409 STALE_VERSION` and must reload. |
| Environments | `env` is always one of `dev`, `staging`, `prod`. |
| Lists | List endpoints return `{ "items": [...], "nextCursor": "..." | null }`. Pass `cursor` to get the next page. `limit` is 1–100, default 25. |
| Dates | ISO 8601 strings in UTC, for example `"2026-11-13T14:05:00.000Z"`. |
| Errors | Always `{ "error": { "code", "message", "requestId" } }`. See the table at the end. |
| Audit | Every successful write inserts an audit event in the same database transaction. |

## Data dictionary

Server-owned fields (`id`, `version`, `createdAt`, `updatedAt`, `prefix`, hashes) are never accepted
from the client; if sent they are ignored.

### Flag

| Field | Type | Source | Rule |
|---|---|---|---|
| id | uuid | Server | Unique, immutable |
| key | string | Client (create only) | 3–50 chars, lowercase letters, digits and hyphens, must start and end with a letter or digit; unique within the team; immutable |
| name | string | Client | 1–100 chars, trimmed |
| description | string | Client | 0–500 chars, trimmed, default `""` |
| archived | boolean | Client (Admin, PATCH) | `true` hides the flag from the default list and makes every evaluation `false` |
| version | integer | Server | Starts at 1, +1 on every change |
| environments | object | Server | `dev`, `staging`, `prod`, each `{ enabled, percentage, version }`. New flags start `enabled: false`, `percentage: 0` everywhere |
| createdBy | uuid | Server | User id |
| createdAt, updatedAt | datetime | Server | |

### Rollout (one per flag and environment)

| Field | Type | Source | Rule |
|---|---|---|---|
| flagId, env | uuid, string | URL | |
| percentage | number | Client | 0–100, up to 2 decimals. A missing row means 0 |
| version | integer | Server | Optimistic locking |

### UserRule (allow / block list entry)

| Field | Type | Source | Rule |
|---|---|---|---|
| id | uuid | Server | |
| flagId, env | uuid, string | URL | |
| userId | string | Client | 1–100 chars, the end user's id in the client app; unique per flag + env |
| kind | string enum | Client | `allow` or `block` |

### ApiKey

| Field | Type | Source | Rule |
|---|---|---|---|
| id | uuid | Server | |
| name | string | Client | 1–60 chars |
| env | string enum | Client | The only environment this key may evaluate |
| prefix | string | Server | First 12 chars of the key, e.g. `ffm_staging_`, safe to display |
| key | string | Server | The full key. Returned **once**, in the `201` response. Only its SHA-256 is stored |
| createdAt, lastUsedAt, revokedAt | datetime or null | Server | |

### AuditEvent (append-only)

| Field | Type | Rule |
|---|---|---|
| id | integer | |
| at | datetime | |
| actorLabel | string | The user's email, `api-key:<prefix>` or `anonymous` |
| actorId | uuid or null | |
| category | string enum | `change` or `security` |
| action | string | e.g. `flag.created`, `flag.toggled`, `rollout.updated`, `rule.added`, `key.created`, `key.revoked`, `login.failed`, `access.denied` |
| targetType, targetId | string or null | e.g. `flag`, `<uuid>` |
| details | object | `{ before, after }` for changes, redacted (never passwords or keys) |
| requestId | string | Matches the `X-Request-Id` response header and the log line |

### User (as returned by the API)

| Field | Type | Rule |
|---|---|---|
| id | uuid | |
| email | string | |
| name | string | |
| role | string enum | `admin` or `developer` |
| teamId | uuid | |

---

## S1 · Identity (shared)

### POST /auth/login — create a session

- Who: Public
- Body:

```json
{ "email": "admin@acme.test", "password": "correct horse battery staple" }
```

- `200 OK`, sets the `ffm.sid` cookie:

```json
{ "user": { "id": "7f2c…", "email": "admin@acme.test", "name": "Amira Admin", "role": "admin", "teamId": "a1b2…" } }
```

- Errors: `400` (missing or badly formed fields), `401 UNAUTHENTICATED` (wrong email or password; same message for both), `429 RATE_LIMITED` (5 failed attempts for that email or IP in 15 minutes).
- Every failed attempt writes a `security` audit event `login.failed`.

### POST /auth/logout — destroy the session

- Who: Admin, Developer. Needs `X-CSRF-Token`.
- Body: none
- `204 No Content`, cookie cleared.
- Errors: `401`, `403 CSRF_INVALID`.

### GET /auth/me — current user and CSRF token

- Who: Admin, Developer
- `200 OK`:

```json
{ "user": { "id": "7f2c…", "email": "dev@acme.test", "name": "Dina Developer", "role": "developer", "teamId": "a1b2…" },
  "csrfToken": "9c1e…" }
```

- Errors: `401`.

---

## S1 · Flag Management

A complete flag as returned by the API:

```json
{
  "id": "3d6e…",
  "key": "new-checkout",
  "name": "New checkout flow",
  "description": "Single-page checkout with saved cards.",
  "archived": false,
  "version": 4,
  "environments": {
    "dev":     { "enabled": true,  "percentage": 100, "version": 1 },
    "staging": { "enabled": true,  "percentage": 25,  "version": 3 },
    "prod":    { "enabled": false, "percentage": 0,   "version": 1 }
  },
  "createdBy": "7f2c…",
  "createdAt": "2026-11-10T09:00:00.000Z",
  "updatedAt": "2026-11-13T14:05:00.000Z"
}
```

### GET /flags — search and list

- Who: Admin, Developer
- Query: `q` (matches key or name, max 100 chars), `archived` (`true` to list archived flags, default `false`), `limit`, `cursor`
- `200 OK`: `{ "items": [ <flag>, … ], "nextCursor": "eyJ…" | null }`. An empty team gets `{ "items": [], "nextCursor": null }`.
- Errors: `400` (bad `limit`, `archived` or `cursor`), `401`.
- `q` is sent to Postgres as a parameter, never pasted into SQL (test ST-09).

### GET /flags/:id — one flag

- Who: Admin, Developer
- `200 OK`: `<flag>`
- Errors: `401`, `404 NOT_FOUND` (unknown id, or a flag of another team).

### POST /flags — create (all environments off)

- Who: Admin, Developer. Needs `X-CSRF-Token`.
- Body:

```json
{ "key": "dark-mode", "name": "Dark mode", "description": "Dark colour theme for the storefront." }
```

- `201 Created`: `<flag>` with `enabled: false` and `percentage: 0` in all three environments.
- Errors: `400 VALIDATION_ERROR` (key format, name length …), `401`, `403 CSRF_INVALID`, `409 CONFLICT` (key already used in this team).
- Audit: `flag.created`.

### PATCH /flags/:id — edit name/description, archive or unarchive

- Who: Admin, Developer for `name` and `description`. **Admin only** when the body contains `archived`. Needs `X-CSRF-Token`.
- Body (any of the optional fields, `version` required):

```json
{ "name": "Dark mode v2", "description": "…", "archived": true, "version": 4 }
```

- `200 OK`: `<flag>` with `version` + 1.
- Errors: `400`, `401`, `403 FORBIDDEN` (Developer sends `archived`), `403 CSRF_INVALID`, `404`, `409 STALE_VERSION`.
- Audit: `flag.updated`, `flag.archived` or `flag.unarchived`.

### DELETE /flags/:id — delete an archived flag

- Who: Admin. Needs `X-CSRF-Token`.
- `204 No Content`
- Errors: `401`, `403`, `404`, `409 CONFLICT` (the flag is not archived: archive it first).
- Audit: `flag.deleted`.

### PATCH /flags/:id/environments/:env — turn a flag on or off in one environment

- Who: Admin, Developer. **Admin only when `env` is `prod`.** Needs `X-CSRF-Token`.
- Body: `{ "enabled": true, "version": 1 }`
- `200 OK`:

```json
{ "flagId": "3d6e…", "env": "staging", "enabled": true, "version": 2, "updatedAt": "2026-11-13T14:05:00.000Z" }
```

- Errors: `400` (bad `env` or `enabled` not boolean), `401`, `403 FORBIDDEN` (Developer on prod; also writes `access.denied`), `403 CSRF_INVALID`, `404`, `409 STALE_VERSION`.
- Audit: `flag.toggled` with `{ before: { enabled: false }, after: { enabled: true } }`.

---

## S2 · Rollout Service

### GET /rollouts/:flagId — percentages for all environments

- Who: Admin, Developer
- `200 OK`:

```json
{ "flagId": "3d6e…",
  "environments": { "dev": { "percentage": 100, "version": 1 }, "staging": { "percentage": 25, "version": 3 }, "prod": { "percentage": 0, "version": 1 } } }
```

- Errors: `401`, `404`.

### PUT /rollouts/:flagId/:env — set the percentage

- Who: Admin, Developer. **Admin only when `env` is `prod`.** Needs `X-CSRF-Token`.
- Body: `{ "percentage": 25, "version": 3 }`
- `200 OK`:

```json
{ "flagId": "3d6e…", "env": "staging", "percentage": 25, "version": 4, "updatedAt": "2026-11-13T14:05:00.000Z" }
```

- Errors: `400 VALIDATION_ERROR` ("percentage must be a number between 0 and 100"), `401`, `403`, `404`, `409 STALE_VERSION`.
- Audit: `rollout.updated` with before/after percentage.
- Rule: the user bucket depends only on `flagKey` and `userId`, never on the percentage, so raising 25 → 50 keeps everyone who was already in.

### GET /rollouts/:flagId/:env/rules — allow and block list

- Who: Admin, Developer
- `200 OK`:

```json
{ "items": [ { "id": "c0ffee…", "userId": "u-981", "kind": "allow", "createdAt": "2026-11-12T10:00:00.000Z" } ] }
```

- Errors: `400` (bad env), `401`, `404`.

### POST /rollouts/:flagId/:env/rules — add a user to the allow or block list

- Who: Admin, Developer. **Admin only when `env` is `prod`.** Needs `X-CSRF-Token`.
- Body: `{ "userId": "u-981", "kind": "allow" }`
- `201 Created`: the rule object above.
- Errors: `400`, `401`, `403`, `404`, `409 CONFLICT` (that user already has a rule for this flag and env; delete it first).
- Audit: `rule.added`.

### DELETE /rules/:ruleId — remove a rule

- Who: Admin, Developer. **Admin only when the rule's env is `prod`.** Needs `X-CSRF-Token`.
- `204 No Content`
- Errors: `401`, `403`, `404`.
- Audit: `rule.removed`.

### POST /preview — "would user X see flag Y?"

- Who: Admin, Developer. **Admin only when `env` is `prod`.** Needs `X-CSRF-Token`. Reads only; nothing is written.
- Body: `{ "flagKey": "new-checkout", "env": "staging", "userId": "u-981" }`
- `200 OK`:

```json
{ "flagKey": "new-checkout", "env": "staging", "userId": "u-981", "enabled": true, "reason": "allowlisted", "bucket": 1342 }
```

  `reason` is one of `archived`, `disabled`, `blocklisted`, `allowlisted`, `in-percentage`, `out-of-percentage`. `bucket` is 0–9999.
- Errors: `400`, `401`, `403`, `404` (unknown flag key).

### POST /evaluations — a client app asks for a flag value

- Who: Scoped key (`Authorization: Bearer ffm_staging_…`). No cookie, no CSRF.
- Body: `{ "flagKey": "new-checkout", "userId": "u-981" }`
- `200 OK`: `{ "flagKey": "new-checkout", "env": "staging", "enabled": true }`
- Errors: `400`, `401 UNAUTHENTICATED` (missing, unknown or revoked key), `403 KEY_SCOPE` (the flag is evaluated in the key's own env; a key never evaluates another env. If a client asks for a flag the team does not own: `404`), `429 RATE_LIMITED` (per key, 120 requests per minute), `503 DB_UNAVAILABLE` (client apps must treat the flag as off).
- Side effect: `lastUsedAt` is updated. Not audited (it would flood the log); counted on the monitoring page instead.

Evaluation order: archived → `false`; env disabled → `false`; user blocklisted → `false`; user allowlisted → `true`; otherwise `sha256(flagKey + ":" + userId)` mod 10000 < percentage × 100.

### GET /keys — list keys (never the secret)

- Who: Admin
- `200 OK`:

```json
{ "items": [ { "id": "k1…", "name": "Storefront staging", "env": "staging", "prefix": "ffm_staging_", "createdAt": "…", "lastUsedAt": "…", "revokedAt": null } ] }
```

- Errors: `401`, `403 FORBIDDEN` (Developer).

### POST /keys — create a key, shown once

- Who: Admin. Needs `X-CSRF-Token`.
- Body: `{ "name": "Storefront staging", "env": "staging" }`
- `201 Created`:

```json
{ "id": "k1…", "name": "Storefront staging", "env": "staging", "prefix": "ffm_staging_", "key": "ffm_staging_Ab12…(shown once)", "createdAt": "…" }
```

- Errors: `400`, `401`, `403`.
- Audit: `key.created` (the audit row holds the prefix only).

### DELETE /keys/:id — revoke

- Who: Admin. Needs `X-CSRF-Token`.
- `204 No Content`. The row stays with `revokedAt` set; the key stops working immediately.
- Errors: `401`, `403`, `404`.
- Audit: `key.revoked`.

---

## S3 · Audit and Monitoring

An audit event as returned by the API:

```json
{
  "id": 1042,
  "at": "2026-11-13T14:05:00.000Z",
  "actorLabel": "dev@acme.test",
  "actorId": "7f2c…",
  "category": "change",
  "action": "rollout.updated",
  "targetType": "rollout",
  "targetId": "3d6e…/staging",
  "details": { "before": { "percentage": 0 }, "after": { "percentage": 25 } },
  "requestId": "4d575877-…"
}
```

### GET /audit — filter and page through events

- Who: Admin, Developer
- Query: `actor` (email or `api-key:<prefix>`), `action`, `category`, `from`, `to` (ISO dates), `limit`, `cursor`
- `200 OK`: `{ "items": [ <event>, … ], "nextCursor": … }`, newest first.
- Errors: `400` (bad date or cursor), `401`.

### GET /audit/summary?days=7 — numbers for the summary card

- Who: Admin, Developer
- `200 OK`:

```json
{ "days": 7, "changes": 42, "securityEvents": 9, "failedLogins": 6, "prodChanges": 3, "alertsOpen": 1 }
```

- Errors: `400` (`days` not 1–90), `401`.

### GET /audit/export.csv — download

- Who: Admin
- Same filters as `GET /audit`, no paging.
- `200 OK`, `Content-Type: text/csv`, `Content-Disposition: attachment; filename="audit-<from>-<to>.csv"`. Columns: `at, actor, category, action, targetType, targetId, requestId, details`. Values starting with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets do not run them as formulas.
- Errors: `400`, `401`, `403 FORBIDDEN` (Developer).

### GET /monitoring — security dashboard numbers

- Who: Admin
- Query: `hours` (1–168, default 24)
- `200 OK`:

```json
{ "hours": 24,
  "failedLogins": 12, "forbidden": 3, "serverErrors": 0, "rateLimited": 2, "alertFailures": 1,
  "topFailedLoginIps": [ { "ip": "203.0.113.9", "count": 11 } ],
  "series": [ { "hour": "2026-11-13T13:00:00.000Z", "failedLogins": 11, "forbidden": 1, "serverErrors": 0 } ] }
```

- Errors: `400`, `401`, `403`.

### GET /alert-rules and PUT /alert-rules

- Who: Admin. PUT needs `X-CSRF-Token`.
- `GET` `200 OK` / `PUT` body and `200 OK`:

```json
{ "rules": [ { "rule": "prod_change", "enabled": true }, { "rule": "key_change", "enabled": true }, { "rule": "login_failures", "enabled": false } ] }
```

- Errors: `400` (unknown rule name), `401`, `403`.
- Audit: `alert_rules.updated`.

### POST /alerts/:auditId/github-issue — create (or retry) the GitHub issue for an alert

- Who: Admin. Needs `X-CSRF-Token`.
- Body: none
- `201 Created`:

```json
{ "alertId": "al1…", "auditEventId": 1042, "status": "sent", "githubIssueNumber": 17, "githubIssueUrl": "https://github.com/<owner>/<repo>/issues/17" }
```

- Errors: `401`, `403`, `404` (no alert for that audit id), `502 UPSTREAM_FAILED` (GitHub rejected or timed out; the alert stays `failed` with `lastError` and can be retried).
- The GitHub token is read from the server environment only and never appears in any response or log.

---

## S2 · Operations

### GET /health

- Who: Public
- `200 OK`: `{ "status": "ok", "db": "ok", "commit": "3854977…" }`
- `503`: `{ "status": "degraded", "db": "down", "commit": "…" }`. Never `500`.

---

## Error responses

Every error uses the same shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "percentage must be a number between 0 and 100.", "requestId": "4d575877-6b44-48fe-aa2d-17b3d1b53f2d" } }
```

`requestId` also comes back in the `X-Request-Id` header and appears in the server log line, so a
screenshot of an error can be matched to its log entry.

| Status | Code | Returned when |
|---|---|---|
| 400 | `VALIDATION_ERROR` | A field is missing, the wrong type or breaks a rule (the message names the field); or the body is not valid JSON |
| 401 | `UNAUTHENTICATED` | No or expired session cookie; wrong login; missing, unknown or revoked API key |
| 403 | `FORBIDDEN` | Wrong role: Developer on prod, Developer on keys, Developer exporting audit |
| 403 | `CSRF_INVALID` | A cookie-authenticated write without a valid `X-CSRF-Token` |
| 403 | `KEY_SCOPE` | An API key used outside its environment |
| 404 | `NOT_FOUND` | The id does not exist or belongs to another team |
| 404 | `ROUTE_NOT_FOUND` | The method and path match no endpoint |
| 409 | `CONFLICT` | Duplicate flag key or rule; deleting a flag that is not archived |
| 409 | `STALE_VERSION` | The `version` sent is older than the row; reload and try again |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 10 kB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | A body was sent without `Content-Type: application/json` |
| 429 | `RATE_LIMITED` | Too many failed logins, or too many evaluations for one key |
| 500 | `INTERNAL_ERROR` | Anything unexpected. Details are only in the log under the `requestId` |
| 502 | `UPSTREAM_FAILED` | GitHub rejected or did not answer the issue request |
| 503 | `DB_UNAVAILABLE` | The database is unreachable |

## Where each status code is produced

| Code | File |
|---|---|
| 400 bad JSON, 413, 500 | `backend/middleware/errors.js` |
| 400 field rules | each service's `controller.js` (zod schema) |
| 401, 403 FORBIDDEN | `backend/middleware/auth.js`, `require-role.js` |
| 403 CSRF_INVALID | `backend/middleware/csrf.js` |
| 404 ROUTE_NOT_FOUND | `backend/middleware/not-found.js` |
| 404 NOT_FOUND, 409 | the owning service's `controller.js` after the service returns nothing / zero rows |
| 415 | `backend/middleware/require-json.js` |
| 429 | `backend/services/auth/controller.js` (login), `backend/services/keys-evaluation/controller.js` (evaluations) |
| 503 | `backend/app.js` (health), `keys-evaluation/controller.js` (evaluations) |
