# API test plan run (tests/test-plan/run-test-plan.js)

Local stack, fresh seeded database, 2026-11-27. Every row of docs/api-test-plan.md that can run over HTTP or against the database as ffm_app. Request ids can be looked up in the audit log and the API log.

| ID | Actual result | Result | Request id |
|---|---|---|---|
| AUTH-01 | 200, role admin, cookie HttpOnly; SameSite=Strict (Secure is added on Vercel) | Pass | `c1178a89-26d5-4da8-b65a-ffd5e601e3b0` |
| AUTH-02 | 401 UNAUTHENTICATED "Invalid email or password." | Pass | `ff673500-0adb-4a6f-ba93-e11cc2313876` |
| AUTH-03 | 401 UNAUTHENTICATED, same message as AUTH-02: yes (339 ms vs 351 ms; dummy bcrypt hash for unknown emails) | Pass | `ad47eafc-48e7-4d1b-88c0-906e471b7a03` |
| AUTH-04 | 400 VALIDATION_ERROR "email: Invalid input: expected string, received number" | Pass | `17508874-267c-4b2a-b4fc-775e654e9d0f` |
| AUTH-06 | 200, user admin@acme.test, csrfToken present: true | Pass | `980798d6-7887-4f3e-9db2-45465e188ade` |
| AUTH-07 | 401 UNAUTHENTICATED | Pass | `754bafa7-d612-40e7-997d-b3e9a06181ed` |
| AUTH-09 | 403 CSRF_INVALID | Pass | `a6d66ae2-3a16-4490-a82c-d40049f55790` |
| AUTH-08 | logout 204, then /auth/me 401 | Pass | `98463ccb-2fff-452e-b630-7a0b0f35062f` |
| AUTH-10 | session row held a password: false; row deleted after logout: true | Pass |  |
| G-01 | 200 status ok, db ok, commit local | Pass | `c7fd24dc-5e8e-4ddb-9332-4ce9e46e0cd9` |
| G-03 | 404 ROUTE_NOT_FOUND | Pass | `65c1880c-7427-4e2e-adb4-a5609cbd0c8e` |
| G-04 | 415 UNSUPPORTED_MEDIA_TYPE | Pass | `5ca04510-e304-4c97-a326-2b9d45c092a2` |
| G-05 | 400 VALIDATION_ERROR "Request body is not valid JSON."; health afterwards 200 | Pass | `73ea042f-d6a7-4b8e-aa89-0911236f6aa5` |
| G-06 | 413 PAYLOAD_TOO_LARGE | Pass | `63daf057-8e0d-4a35-bbe6-53db69d4685c` |
| G-07 | body requestId 65c1880c… = X-Request-Id 65c1880c… (log line: see api log) | Pass | `65c1880c-7427-4e2e-adb4-a5609cbd0c8e` |
| G-08 | nosniff: nosniff, X-Powered-By: absent | Pass | `c7fd24dc-5e8e-4ddb-9332-4ce9e46e0cd9` |
| FLG-01 | 200, 2 flags: dark-mode, new-checkout; search-v2 absent, Globex's loyalty-points absent | Pass | `edce6820-c9de-4c05-8ed6-9320d37dbcae` |
| FLG-02 | 200, archived list: search-v2 | Pass | `d531cfdc-6f4f-4e20-bbc1-1720d8ed8c42` |
| FLG-03 | 200, new-checkout | Pass | `0c66473c-5806-4496-996c-d01d8e053abe` |
| FLG-04 | pages: dark-mode → new-checkout; no duplicate; last nextCursor null | Pass | `8d185daf-5228-4d36-a6e8-98a0cb9eb92f` |
| FLG-05 | 400 VALIDATION_ERROR | Pass | `b96e248f-7bc5-4c2c-83f6-8b2fae77ab48` |
| FLG-06 | 200, environments: dev, prod, staging | Pass | `34678717-6109-44d3-95d9-45bef0fbb4a7` |
| FLG-07 | 404 NOT_FOUND | Pass | `4038a846-edd4-4a0d-939e-14b5eb909537` |
| FLG-08 | 201, dev off 0%, staging off 0%, prod off 0%, version 1 | Pass | `5faf19b7-1c72-45ff-bf9d-da8831fd3425` |
| FLG-09 | 409 CONFLICT | Pass | `1e6fa98b-252f-4842-ada6-cf7be786f295` |
| FLG-10 | 400 VALIDATION_ERROR "key must be 3–50 lowercase letters, digits or hyphens, starting and ending with a letter or digit" | Pass | `272ec138-f0df-45e0-b3e1-270d51472455` |
| FLG-11 | 201, id 7cfb71ba… (not the client's), version 1, createdAt 2026-11-27 | Pass | `96e922b2-a766-4e5a-9ce5-65cb0d313547` |
| FLG-12 | 200, name Renamed, version 2 | Pass | `c1a3f539-0262-4c6d-b126-445490952966` |
| FLG-13 | 409 STALE_VERSION | Pass | `d7e685d1-c4bf-4faa-a8c0-45b265e0a657` |
| FLG-14 | 403 FORBIDDEN | Pass | `d2aadd29-bf42-470c-bac0-391917c0b2a1` |
| FLG-16 | 409 CONFLICT | Pass | `4005ab2d-7f0c-4189-b65c-3e67c36fefba` |
| FLG-15 | 200, archived true; flag.archived in the audit log: true | Pass | `a5b4dd8f-e02a-4b2f-bc54-38bc347a79e3` |
| FLG-18 | 403 FORBIDDEN | Pass | `b302a910-0a4b-4b8b-b02b-4b28be63948a` |
| FLG-17 | 204, then GET 404 | Pass | `4d3cb671-a5c0-4b95-9a22-7106d2af1cc6` |
| FLG-19 | 200, enabled true; audit flag.toggled before {"enabled":false} after {"enabled":true} | Pass | `e472d0a1-49c2-4153-99ff-3d84bed2320e` |
| FLG-20 | 403 FORBIDDEN; access.denied with the same requestId: true | Pass | `04f51ee8-eacf-4f87-b94f-967be28d0b1c` |
| FLG-21 | 400 VALIDATION_ERROR | Pass | `4fc4415a-8c02-4a9e-bd04-62e5258bc73a` |
| FLG-22 | 400 VALIDATION_ERROR | Pass | `ccc24697-501f-422f-a690-0346ba995140` |
| FLG-23 | 6 write routes: 403 CSRF_INVALID; flags created: 0 | Pass |  |
| ROL-01 | 200: dev 100, staging 25, prod 0 | Pass | `175ae8aa-476b-48cd-b5af-f46d6091a76a` |
| ROL-02 | 200, percentage 50, version 1 → 2; audit before 25 after 50 | Pass | `1bfd9372-b557-4563-a98c-c1a02bbe9ecf` |
| ROL-03 | 409 STALE_VERSION | Pass | `43f0c056-f509-4b6c-a0aa-bd6093816495` |
| ROL-04 | 400 VALIDATION_ERROR "percentage must be a number between 0 and 100" | Pass | `154d4fe3-615f-4a69-a8a1-e888b4e090ed` |
| ROL-05 | 400 VALIDATION_ERROR "percentage must be a number between 0 and 100" | Pass | `65e89f87-7572-4cbf-a17f-5fdd6268aaab` |
| ROL-06 | 400 VALIDATION_ERROR "percentage can have at most 2 decimals" (contract: max 2 decimals) | Pass | `6152dc3d-4823-46e4-9c21-8b16dd484585` |
| ROL-07 | 403 FORBIDDEN | Pass | `ab7f7a7e-abba-4737-85b2-1574d300b6c3` |
| ROL-08 | 200 | Pass | `07273d05-30a6-4397-b330-e462ebb7f8dc` |
| ROL-09 | 404 NOT_FOUND (Globex flag loyalty-points) | Pass | `475f0551-5646-4087-ab2b-80a713c91261` |
| ROL-10 | 200, 0 rules | Pass | `401efe12-33f7-4c73-809e-34b54d2cf3d7` |
| ROL-11 | 201, id db28b794…; rule.added audited | Pass | `c5a242a3-3025-44ab-831e-72613e4a46e7` |
| ROL-12 | 409 CONFLICT | Pass | `bfd39ffb-cec6-4364-8208-6968757b57f0` |
| ROL-13 | 400 VALIDATION_ERROR | Pass | `8202efb0-3f00-40e4-9334-c40aeb91f9d4` |
| ROL-14 | 204, list afterwards 0 | Pass | `92125fbc-426f-48a6-95ba-1b1fa881db3c` |
| ROL-15 | 404 NOT_FOUND | Pass | `7be4a51d-2496-49e1-b6ff-f35bda14e714` |
| ROL-16 | 200, enabled true, reason allowlisted | Pass | `bfdb5bca-4ad5-451f-84c6-5812f588b8dc` |
| ROL-17 | 200, enabled false, reason blocklisted | Pass | `0311c5c1-337f-475f-a1dc-b7f1333566dd` |
| ROL-18 | 200, enabled false, reason archived | Pass | `81d6de54-ae50-48f9-8af6-43775614d49c` |
| ROL-19 | 403 FORBIDDEN | Pass | `ddc3c431-5364-4d9e-ae41-49be9ba33a88` |
| ROL-23 | 201, key shown once (ffm_stg_h9XFq5…); GET /keys shows prefix ffm_stg_h9XFq5 and never the key | Pass | `cce7aa38-3fcd-443d-8684-61e7e9e1cc75` |
| ROL-24 | 403 FORBIDDEN | Pass | `44d4c844-6e80-46a6-a135-723c0cb66810` |
| ROL-25 | 400 VALIDATION_ERROR | Pass | `2e135d8a-e63e-4b15-ac92-6841fe7c984e` |
| ROL-26 | 200, env staging, enabled true; lastUsedAt set: true | Pass | `a55eb53e-4dea-477e-8eae-5205f0fe2490` |
| ROL-27 | 401 UNAUTHENTICATED "Send a valid API key as "Authorization: Bearer <key>"." | Pass | `5a006cb0-10e3-4010-961c-1e9313aec448` |
| ROL-28 | 401 UNAUTHENTICATED "The API key is missing, unknown or revoked."; differs from ROL-27's "Send a valid API key as "Authorization: Bearer <key>"." (unknown and revoked keys do share one message, so no key is revealed) | **Fail** | `70a77103-37ed-4696-aa61-a114ad37dfa4` |
| ROL-29 | 200, env staging, enabled false (prod is on at 100%) | Pass | `1bc3dea9-3626-48a0-aeaf-ff77f2133b55` |
| ST-06 | staging key on a prod-only flag: enabled false; with "env":"prod" in the body: 400 VALIDATION_ERROR "Unknown field: env." | Pass | `686c682c-c669-445c-b137-814c8c8bb545` |
| ROL-34 | 200, env staging, flags {"new-checkout":true,"dark-mode":false,"search-v2":false}, notFound ["loyalty-points"] (Globex's flag is not visible) | Pass | `6f00098c-c1ae-4d7e-8a43-7e84437c8707` |
| ROL-35 | env: 400 VALIDATION_ERROR; 51 keys: 400 VALIDATION_ERROR; repeated key: 400 VALIDATION_ERROR | Pass | `7e3d7eac-29ab-472e-8767-ed002ed4d568` |
| ROL-33 | api_keys columns: id, team_id, env, name, prefix, key_hash, created_by, created_at, last_used_at, revoked_at; stored hash ≠ key; only the prefix ffm_stg_h9XFq5 is readable | Pass |  |
| ROL-30 | revoke 204, then evaluation 401 UNAUTHENTICATED; key.revoked audited | Pass | `18aa7a19-4aed-4ac2-bd65-185186a1dea1` |
| ST-07 | revoke 204, evaluation with the revoked key 401 UNAUTHENTICATED | Pass | `18aa7a19-4aed-4ac2-bd65-185186a1dea1` |
| ST-08 | 403 FORBIDDEN | Pass | `bf9344ac-9f27-465f-a15e-6cafd6f8cec1` |
| AUD-01 | 200, newest: flag.toggled by admin@acme.test, requestId matches the toggle: true | Pass | `a792fc5d-cfdf-48ea-873e-db70edbf0a0d` |
| AUD-02 | 200, 4 events, all rollout.updated | Pass | `906c1136-d88b-43a1-8bcc-d8d4eed50c18` |
| AUD-03 | 200, 16 events, all by dev@acme.test | Pass | `12de6293-dba1-4270-b7b2-0edf8928be90` |
| AUD-04 | 200, 0 events in the window (empty is 200, not 404) | Pass | `38211f50-fae6-44f4-b960-4d0882e05c8f` |
| AUD-05 | 400 VALIDATION_ERROR | Pass | `7dd253f4-e844-40b9-a97d-00a7dea65f3b` |
| AUD-06 | ids 32, 31, 30, 29: no gap between pages, no duplicate | Pass | `abadab80-9a58-498b-a195-db6dd53a5c8c` |
| AUD-07 | 401 UNAUTHENTICATED | Pass | `09b2f219-eec2-4d92-a220-6753c802d562` |
| AUD-08 | 200, 0 events, none from Acme | Pass | `0f83fa03-14a5-492d-bafa-084798ba7d81` |
| AUD-09 | 200 {"days":7,"changes":22,"securityEvents":9,"failedLogins":1,"prodChanges":3,"alertsOpen":0} | Pass | `d86c838f-8e61-487a-a8b7-d113a141704f` |
| AUD-10 | 400 VALIDATION_ERROR | Pass | `a00665b8-3098-456c-ac89-a987212812fb` |
| AUD-11 | 200 text/csv; charset=utf-8, attachment; filename="audit-start-now.csv"; cells starting with = + - @: 0; csv.cell('=HYPERLINK…') → "'=HYPERLINK("… | Pass | `186b2c86-4604-454a-83f5-6735fa3ecafd` |
| ST-17 | export as Admin: 0 cells start with = + - @ | Pass | `186b2c86-4604-454a-83f5-6735fa3ecafd` |
| AUD-12 | 403 FORBIDDEN | Pass | `4e9a7bc1-5d01-4ece-afce-f375a62b3d92` |
| ST-12 | 403 FORBIDDEN | Pass | `4e9a7bc1-5d01-4ece-afce-f375a62b3d92` |
| AUD-13 | details as stored: {"after":{"key":"redact-mwzk69ak","name":"Redaction test","version":1,"archived":false,"description":"key [REDACTED]"}} | Pass | `f7fdf6db-f2ab-4447-98d5-0df56ee7356e` |
| AUD-16 | 403 FORBIDDEN | Pass | `f392715c-9ad9-4580-93cd-f28eac096c62` |
| AUD-17 | 400 VALIDATION_ERROR | Pass | `e25f5f5c-2f30-4578-88b0-787333a62bea` |
| AUD-19 | 400 VALIDATION_ERROR | Pass | `2c9dd0d4-5134-44d2-8a5b-9beb01558a5a` |
| AUD-20 | toggle 200; alert prod_change for audit event 37, status failed (GitHub is not configured (GITHUB_TOKEN and GITHUB_REPO).) | Pass | `def7bbfa-57d4-4b05-a55b-889db863b005` |
| AUD-18 | 200; the next prod toggle (audit event 39) raised an alert: false | Pass | `c4badf29-dccf-489c-892a-7b49760ec3d9` |
| AUD-23 | 403 FORBIDDEN | Pass | `e0cf1173-30c5-468a-922b-142d6bfacf09` |
| AUD-24 | 404 NOT_FOUND | Pass | `a8ac7ef3-1906-45f2-80b5-8a0c0cddd696` |
| ST-01 | 401 UNAUTHENTICATED, no data in the body | Pass | `5029d974-af22-4d51-b7b8-cdf6fe38e3bc` |
| ST-02 | Developer prod toggle: 403 FORBIDDEN; access.denied logged with the same requestId (FLG-20) | Pass | `04f51ee8-eacf-4f87-b94f-967be28d0b1c` |
| ST-03 | Globex opens Acme's new-checkout: 404 NOT_FOUND | Pass | `bcfb1f3e-463e-426a-8ff9-d4739637a8b5` |
| ST-04 | 403 CSRF_INVALID | Pass | `88a9c9e1-ba66-4cd3-a3ec-fbdb16f50a46` |
| ST-05 | percentage 150: 400 VALIDATION_ERROR; "abc": 400 VALIDATION_ERROR; row unchanged (ROL-03 version still current) | Pass | `154d4fe3-615f-4a69-a8a1-e888b4e090ed` |
| ST-09 | q=' OR 1=1--: 200, 0 rows; XSS description stored as plain text (201); React renders it as text | Pass | `6d95066c-eccb-4955-b1ad-4ce717f6d231` |
| ST-15 | 403 BOT_CHECK_FAILED | Pass | `cf4f9d6d-6848-490d-8a69-e8aeaa8a501c` |
| ST-10 | as ffm_app: UPDATE / DELETE / TRUNCATE audit_events → 42501 / 42501 / 42501 (42501 = permission denied) | Pass |  |
| AUD-14 | as ffm_app: UPDATE / DELETE / TRUNCATE audit_events → 42501 / 42501 / 42501 (42501 = permission denied) | Pass |  |
| AUTH-05 | responses 401 401 401 429 429 429; login.failed events: 7 | Pass | `c129feb0-0101-44e6-af73-ee643812b585` |
| AUD-15 | failedLogins 7, top IP ::1 × 7 | Pass | `9e89c0bd-0461-49f5-83a3-85dc7d97f2d7` |
| ST-11 | 6th wrong password 429; monitoring card failedLogins 7 | Pass | `c129feb0-0101-44e6-af73-ee643812b585` |
