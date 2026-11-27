# docs/

Design and test documents for the Feature Flag Manager.

- `architecture.md`: the two deployments (Vercel live, Floci AWS), the three layers and services, request flows, trust boundaries, AWS services per student, and why this cloud model.
- `threat-model.md`: 13 app-specific threats, each mapped to the control that stops it and the test that proves it; shared responsibility; residual risks.
- `api-contract.md`: every endpoint with request/response JSON, the data dictionary and the error table. Change it only through a PR all three owners approve.
- `api-test-plan.md`: normal, invalid and security tests per service, with Actual result / Pass-Fail columns to fill in.
- `load-test-results.md`: k6 load, spike, stress and rate-limit results, plus the Lab 8 scaling and failover runs on Floci.

AWS setup on Floci is documented next to its scripts: `infra/floci/services/README.md` (Lambdas, API Gateway, alert outbox), `infra/iam/README.md` (every IAM role) and `infra/floci/lab8/README.md` (Lab 8).
