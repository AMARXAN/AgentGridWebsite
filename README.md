# AgentGrid

AgentGrid is an early-stage AI workspace built with React, TypeScript, Vite, Express, SQLite, and the Google Gemini API. This repository is a working MVP—not a certified production service. The main flows are backed by the API; production identity, payments, multi-instance storage, and formal security review remain outstanding.

## Current capabilities

- Email/password registration and login; password hashes use Node.js `scrypt`.
- 12-hour signed bearer tokens and workspace-scoped API access. The frontend stores the token in tab-scoped `sessionStorage`; this is a persistence improvement, not a replacement for HttpOnly secure-cookie sessions.
- Persistent agent definitions and status; tasks can be assigned an agent and use its role/instructions.
- Text knowledge sources scoped to a workspace; up to ten recent sources are added as untrusted reference context to agent tasks, with a total context limit.
- Persistent task creation, bounded Gemini execution, saved outputs, and activity events.
- Per-workspace daily AI request quota (`DAILY_AI_REQUEST_LIMIT`) and token usage records when provider usage metadata is returned.
- Basic request rate limits, request body size limits, HTTP security headers, and production checks for `AUTH_SECRET`.
- Unit tests for password/token handling and agent prompt construction.

## Requirements

- Node.js 22+
- npm
- A Google AI Studio API key: https://aistudio.google.com/app/apikey

## Local setup

```bash
npm install
cp server/.env.example server/.env
```

Edit `server/.env` and set `GEMINI_API_KEY` and a unique `AUTH_SECRET` (at least 32 characters). Generate one with:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Never commit `server/.env`, paste API keys into chat, or put provider keys in frontend variables. `.env` files are ignored by Git.

Run the API and frontend in separate terminals:

```bash
npm run server:dev
npm run dev
```

- API health: http://localhost:3001/api/health
- The Vite development URL is printed in the terminal.

## API endpoints

- `GET /api/health` — service status, selected model, and whether the server key is configured (does not expose the key).
- `POST /api/auth/register` — `{ "email", "password", "workspaceName" }`; password must be 12–128 characters.
- `POST /api/auth/login` — `{ "email", "password" }`.
- `GET /api/auth/me` — current user.
- `GET /api/agents`, `POST /api/agents`, `PATCH /api/agents/:id` — workspace-scoped agents and status.
- `GET /api/tasks`, `POST /api/tasks`, `POST /api/tasks/:id/run` — task management and one bounded Gemini call per run.
- `GET /api/knowledge`, `POST /api/knowledge`, `DELETE /api/knowledge/:id` — plain-text knowledge sources. Each source is limited to 20,000 characters.
- `GET /api/activity` — latest 100 workspace activity events.
- `GET /api/usage` — daily request and token counts plus the configured request limit.
- `POST /api/chat` — authenticated AI Playground prompt.

Protected endpoints use `Authorization: Bearer <token>`. Tokens expire after 12 hours. The server never executes generated shell commands or code. Agent execution currently means one bounded model call, with selected agent instructions and recent workspace text context.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

CI sets `REQUIRE_INTEGRATION_TESTS=true`, which makes the test command fail if the HTTP integration test dependencies are missing instead of silently skipping that test. The current environment used to prepare this archive could not finish `npm install` before its timeout, so a full frontend typecheck/build and browser-based integration run are still required in an environment with package registry access.

## Environment variables

- `GEMINI_API_KEY` — secret Google AI Studio API key.
- `GEMINI_MODEL` — model ID; defaults to `gemini-3.5-flash-lite`.
- `AUTH_SECRET` — unique secret of at least 32 characters in production.
- `PORT` — API port (default `3001`).
- `DATABASE_PATH` — SQLite path; use persistent storage.
- `DAILY_AI_REQUEST_LIMIT` — per-workspace daily AI request quota (default `50`).
- `TRUST_PROXY=true` — only when deployed behind one trusted reverse proxy; otherwise leave false.
- `SERVE_FRONTEND=true` — serve the built frontend from Express in the production container.

## Deployment

The Dockerfile builds the frontend and packages the Node API. Configure `GEMINI_API_KEY`, `AUTH_SECRET`, `DATABASE_PATH`, `DAILY_AI_REQUEST_LIMIT`, and `NODE_ENV=production` as runtime environment variables. Enable HTTPS, persistent storage, backups, and monitoring. The included SQLite approach is intended for a single instance; use managed PostgreSQL plus migrations for multi-instance production.

See [`PRODUCTION_CHECKLIST.md`](./PRODUCTION_CHECKLIST.md) for the release acceptance checklist and remaining blockers.

## Known gaps before a public production launch

- Full dependency installation, TypeScript typecheck, production build, browser tests, and API integration tests must pass in CI.
- The frontend stores bearer tokens in `localStorage`; prefer secure, `HttpOnly`, `Secure`, `SameSite` cookie sessions or another reviewed session architecture before public launch.
- Email verification, password reset, MFA, session revocation, workspace member invitations/management, and stronger account recovery are not implemented.
- Rate limiting is in-memory and per process; use a shared store such as Redis for horizontally scaled deployments. Set trusted proxy behavior correctly.
- Daily request quotas are basic abuse/cost controls, not a billing system. Add monetary spend caps, provider cost reconciliation, subscription/billing integration, and alerts before opening to untrusted users.
- Knowledge base supports plain text only; no file parsing, semantic retrieval, or per-source permissions beyond workspace isolation.
- Integrations catalog is a placeholder. External tools need OAuth, scoped permissions, allowlists, audit logging, and user confirmation for consequential actions.
- Agent status is persisted, but there is no background scheduler, durable queue, retries/backoff, or multi-step tool execution yet.
- Add database migration tooling, restore-tested backups, structured logs, monitoring/alerting, dependency/container vulnerability scans, and an independent security review.
- Add a license before distributing the code publicly.

## Verification

- `npm test` includes unit tests and an HTTP integration test that starts an isolated API process with a temporary SQLite database.
- `npm run verify` runs TypeScript checks, tests, and the production frontend build.
- Do not consider the app production-ready until `npm run verify` and staging/browser checks pass on the exact release commit.


## Verification status

- Unit tests: 9 passing in the authoring environment; the HTTP integration test is skipped unless runtime dependencies are installed.
- Backend JavaScript syntax checks: passing.
- Full HTTP integration test, TypeScript typecheck, and Vite production build: not verified here because dependency installation timed out in this environment. Run `npm install --no-audit --no-fund` and `npm run verify` before deploying.
- This repository source is a development baseline, not a claim of production readiness or a completed security audit.


### Security hardening (v0.4.7)

- Malformed stored password hashes now fail closed as invalid credentials instead of surfacing a server error.
- Added unit coverage for malformed hash formats and non-string inputs.

### Security hardening in v0.4.8

- API responses use `Cache-Control: no-store` and `Pragma: no-cache` to reduce accidental caching of workspace data, credentials, and AI output.
