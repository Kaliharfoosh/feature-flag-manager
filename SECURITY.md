# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub instead: go to the **Security** tab of this repository and choose
**Report a vulnerability**. Include what you found, the steps to reproduce it and the impact you
expect. We aim to reply within a few working days.

## Scope

In scope:

- The live app at https://feature-flag-manager-cyan.vercel.app and its API under `/api/v1`
- The Acme Store demo client at https://ffm-demo-shop.vercel.app
- The code in this repository, including the AWS (Floci) infrastructure scripts

Please don't run load tests, denial-of-service tests or automated scanners against the live sites:
they run on free plans that a heavy test would exhaust.

## How the project is secured

The threats we planned for, the controls that answer them and the tests that prove them are in
[`docs/threat-model.md`](docs/threat-model.md).

## Supported versions

This is a coursework project. Only the latest version on `main` is maintained.
