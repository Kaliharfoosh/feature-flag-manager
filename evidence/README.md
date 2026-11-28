# evidence/

Proof for the evidence pack and the demo. Never put secrets or connection strings in a screenshot.

- `screenshots/` — Vercel deployments, Neon tables, log lines, security test results
- `postman/` — exported Postman collections (integrated workflow + security tests)
- `test-results/` — Jest output, Postman run reports, k6 load test output (`k6-run-*.txt`, see `docs/load-test-results.md`)
- `test-results/floci-services.json` — redacted local Floci inventory and HTTP route checks for S1, S2 and S3; refresh with `node infra/floci/services/capture-evidence.js`. It shows resource presence and basic responses, not real AWS policy enforcement.
