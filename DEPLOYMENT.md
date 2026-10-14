# AgentGrid deployment runbook

This is a deployment baseline, not a claim that the application has already been deployed or security-audited.

## 1. Prepare secrets

Copy `server/.env.example` to `server/.env`. Set a private Google AI Studio API key and a cryptographically random `AUTH_SECRET` of at least 32 characters. Do not commit this file or paste secrets into issues/chat. In production, use your hosting provider's secret manager where available.

Generate a secret locally:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

## 2. Verify locally

```bash
npm install
npm run verify
```

`npm run verify` runs TypeScript checks, Node tests, and a Vite production build. The authoring environment may not have network access to install dependencies; do not interpret that limitation as a successful build.

## 3. Run with Docker Compose

Docker and Docker Compose must be installed first.

```bash
docker compose config
docker compose up --build -d
docker compose ps
curl -fsS http://127.0.0.1:3001/api/health
```

The Compose configuration binds the application to loopback. Put a reviewed TLS reverse proxy in front of it before exposing it publicly. Do not set `TRUST_PROXY=true` unless there is exactly one trusted proxy in front of the app. The SQLite volume persists at `/app/data`.

## 4. Backup and restore

With the app's Node dependencies installed and `DATABASE_PATH` pointing to the active database:

```bash
node --env-file=server/.env scripts/backup-db.mjs ./backups/manual.sqlite
```

Keep backups encrypted and outside the application host. Test restore procedures regularly. For a restore, stop the application, preserve a copy of the current database, replace the database file with a verified backup, and start the application again. Never test restore directly against the only production copy.

## 5. Pre-launch checks

- Run `npm run verify` in CI on the exact commit being deployed.
- Run the app in staging with a separate API key/database and execute registration, login, task, agent, knowledge, and usage flows.
- Verify TLS, domain/DNS, CORS/proxy behavior, rate limits, backup restoration, logs, and alerts.
- Perform an independent security review and dependency/container vulnerability scan.
- Publish privacy policy, terms, AI provider disclosure, retention/deletion policy, and a support contact.

## Known limitations

The current application uses bearer tokens stored by the frontend in `localStorage`; a security review should replace this with reviewed secure session handling before public launch. Email verification, password reset, MFA, invitations/member management, durable distributed job queue, billing, PostgreSQL, distributed rate limiting, file ingestion/retrieval, full browser E2E tests, and external security review are not implemented. Do not expose this build to sensitive or regulated workloads until those gaps are addressed.
