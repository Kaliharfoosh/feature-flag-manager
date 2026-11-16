# IAM for the Floci deployment (Lab 7 style)

| Word | Meaning | Ours |
|---|---|---|
| Role | The badge. A service "wears" it to get permission. | `ffm-api-role` |
| Trust policy | WHO may wear the badge. | Only the Lambda service (`trust-policy.json`) |
| Permissions policy | WHAT the badge opens. | `ffm-api-access` (`ffm-api-policy.json`) |

**Allowed:** read ONE secret (`ffm/api-secrets`: the `ffm_app` connection string and the session
secret) and write logs. The GitHub token is deliberately NOT in it, so local Floci tests cannot
open real GitHub issues.

**Not allowed:** any other secret, deleting anything, changing IAM, any other AWS service.
This is least privilege: only what the function needs. A broad admin policy would let one bug
or one leaked key do anything in the account.

The database itself is protected by a second layer: the `ffm_app` Postgres role
(see `backend/db/grants.sql`). IAM guards the AWS side, `ffm_app` guards the Neon side.

Floci vs real AWS: Floci stores permissions but does not check them by default (Lab 7).
Real AWS checks every call and answers `AccessDeniedException` for anything not listed here.
