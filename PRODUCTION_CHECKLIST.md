# AgentGrid production launch checklist

This checklist is intentionally conservative. A checked item means there is evidence for it in the current source or local verification; it does not imply that the public service is deployed.

## Current source baseline

- [x] React + TypeScript + Vite frontend shell.
- [x] Express API with registration/login and workspace-scoped bearer-token checks.
- [x] Password hashing and signed token tests.
- [x] Persistent SQLite tables for users, memberships, agents, tasks, usage, activity, and text knowledge.
- [x] Workspace-scoped agent/task/knowledge endpoints.
- [x] Gemini server-side calls; bounded prompt/output size.
- [x] Daily workspace request quota with atomic SQLite reservation and provider token metadata capture when available.
- [x] Request rate limit, body size limit, security headers, and production `AUTH_SECRET` check.
- [x] Eleven unit tests pass in the authoring environment (one HTTP integration test remains skipped until runtime dependencies are installed).
- [x] Docker Compose baseline with persistent SQLite volume and healthcheck.
- [x] SQLite backup script and deployment/restore runbook.
- [x] Startup recovery marks interrupted synchronous tasks as failed instead of leaving them stuck in `running`.
- [x] Backend syntax and frontend TSX transpilation syntax checks pass.
- [x] AI task calls now include a separate system instruction reinforcing that user tasks and knowledge documents are untrusted input.
- [x] Failed frontend task runs re-fetch server state so provider configuration errors do not falsely mark a queued task as failed.
- [x] Login rejects malformed/oversized credentials before password verification.
- [ ] Full dependency installation, real TypeScript typecheck, and Vite production build (package installation timed out in the authoring environment).
- [x] HTTP integration test added for registration/login, workspace isolation, agent/task/knowledge endpoints, usage quota metadata, missing-provider-key behavior, and viewer-role write restrictions; CI explicitly fails if runtime dependencies are missing.
- [ ] Run the HTTP integration test after dependencies install successfully; it is explicitly skipped locally when runtime dependencies are missing.
- [ ] Browser-based end-to-end tests.

## Required before public launch

### Identity and access
- [ ] Replace `localStorage` bearer tokens with reviewed secure session handling.
- [ ] Add email verification, password reset, session revocation, MFA, and account abuse protections.
- [ ] Implement workspace invitations, member management, and explicit role permissions.
- [ ] Add automated cross-workspace authorization tests for every endpoint.

### Agent execution and data
- [ ] Add a durable job queue, retries with backoff, timeouts, cancellation, and stuck-job recovery.
- [ ] Add agent edit/delete/versioning and explicit model/prompt configuration.
- [ ] Add knowledge source editing, file parsing, chunking/retrieval, and document-level access controls.
- [ ] Add data retention, export, and account/workspace deletion flows.

### Cost and billing
- [ ] Reconcile provider usage with actual invoices and model pricing.
- [ ] Add per-user/workspace token and monetary spend caps, alerts, and administrative controls.
- [ ] Add billing provider integration only after pricing, currency, tax, refund, and subscription policies are chosen.

### Reliability and operations
- [ ] Add database migrations and move to managed PostgreSQL before multi-instance scaling.
- [ ] Configure persistent storage, automated backups, and a tested restore procedure.
- [ ] Move rate limits to a shared store for multi-instance deployments.
- [ ] Add structured logs, metrics, alerting, uptime checks, and incident procedures.
- [ ] Run dependency/container vulnerability scans and an independent security review.
- [ ] Configure production HTTPS, DNS, secrets, deployment, rollback, and staging environments.
- [ ] Add CI checks for typecheck, tests, build, dependency audit, and E2E smoke tests.

### Product completion
- [ ] Implement integrations with OAuth and least-privilege scopes; current Integrations page is a placeholder.
- [ ] Add product analytics from real events only; do not display fabricated usage/savings.
- [ ] Add accessibility review, responsive browser QA, loading/error/empty states, and localization review.
- [ ] Select and add a software license.
- [ ] Publish a privacy policy, terms of service, AI data handling disclosure, and support contact.

## External inputs required

Production launch cannot be completed solely by editing source code. It needs a private Gemini API key, hosting account, persistent database/storage, domain/HTTPS setup, and (if monetized) a chosen billing provider and verified business settings. Keep all secrets in the hosting provider's secret manager; never put them in the repository or chat.

- [x] Password verification rejects malformed stored hash formats without throwing.

- [x] API responses set `Cache-Control: no-store` and `Pragma: no-cache`; integration test asserts these headers on registration responses.

- [x] Frontend migrates any legacy bearer token from persistent localStorage into tab-scoped sessionStorage; this reduces persistence but is not a substitute for reviewed HttpOnly secure-cookie sessions.
