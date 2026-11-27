# API key management (S1)

Admin-only `GET /api/v1/keys`, `POST /api/v1/keys`, and `DELETE /api/v1/keys/:id`.
Mounted with the flags service on Vercel and the flags Lambda. The API Gateway route table
includes these paths; redeploy the Floci infrastructure to apply those route entries.
No new migration or environment variables are required.

The `/keys` frontend page and command palette entry are visible to Admins. The page supports
live search, environment/status filters, a one-time copyable secret, and a confirmation before
revocation. Full secrets stay only in component memory until hidden or the page is left.

Security: session authentication (not Bearer), Admin role, CSRF on writes, strict input validation,
parameterised SQL scoped to team, UUID validation, no caching, hash-only persistence, and atomic
audit/alert writes. Repeat revocation is idempotent. Unknown and foreign keys return the same 404.

## Verify

- `npm test`: route tests always run; `keys.db.test.js` also runs with `DATABASE_URL` set.
  Database fixtures roll back and cover create/evaluate/revoke/401 in all three environments,
  tenant isolation, safe list responses, key-change alerts, repeated revocation and audit rollback.
- `npm --prefix frontend run lint` and `npm --prefix frontend run build`.
- Sign in as an Admin and open **keys**. Create a disposable staging key, copy it, then hide it.
  Refresh the page: only the prefix remains. Search and filter the list.
- Cancel a revoke once, then confirm it. The row becomes Revoked and has no revoke button.
  Check the audit log for `key.created` and `key.revoked`.
- As a Developer the navigation and command are hidden; directly opening `/keys` shows
  “Admin access required”. Direct API requests receive 403 (ST-08).
- The database-backed tests prove both evaluation endpoints return 401 after revocation (ST-07).
  Do not use the live store's key for a destructive demonstration; create a disposable key.
