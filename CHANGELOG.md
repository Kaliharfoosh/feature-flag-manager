# Changelog

All notable changes to this project are listed here.

## [1.0.0] - 2026-11-27

First complete release: all three services, both deployments, and the full test and security evidence.

### Flag Management (S1)
- Shared sign-in with server-side sessions, CSRF protection, Cloudflare Turnstile and login lockout
- Create, toggle, archive and delete flags per environment (`dev`, `staging`, `prod`), with Admin-only changes to `prod`

### Rollout Service (S2)
- Percentage rollouts with deterministic user bucketing, plus allow and block rules with preview
- `POST /evaluations` and `POST /evaluations/batch` with environment-scoped API keys
- Per-key rate limit of 120 requests/minute shared across instances (`429` + `Retry-After`)
- Acme Store demo client driven by 28 live flags
- AWS deployment on Floci: one Lambda per service behind API Gateway, Secrets Manager, least-privilege IAM roles

### Audit and Monitoring (S3)
- Append-only audit log written in the same transaction as each change, with export
- Monitoring pages and security alerts delivered as GitHub issues
- SQS alert outbox with dead-letter queue and replay, CloudWatch metrics and alarm, SNS notifications
- EventBridge Scheduler jobs: alert sweeper every 10 minutes and a daily audit summary

### Quality and security
- GitHub Actions CI: migrations, Jest tests as the least-privilege role, `npm audit`, frontend build, gitleaks
- k6 load, spike, stress and rate-limit tests; Lab 8 scaling and failover runs on Floci
- Vercel Firewall rules, HSTS and security headers
- Architecture and threat model documentation

[1.0.0]: https://github.com/Kaliharfoosh/feature-flag-manager/releases/tag/v1.0.0
