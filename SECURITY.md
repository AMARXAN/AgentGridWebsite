# Security policy

## Reporting a vulnerability

Do not post secrets, API keys, personal data, or exploit details in a public issue. Until a private security contact is configured for this project, contact the repository owner through a private channel and include a concise description, impact, reproduction steps, and affected version.

## Current security status

This project is an evolving development baseline and has not undergone an independent security audit. Before public production use, review authentication/session storage, workspace authorization, abuse controls, dependency vulnerabilities, database backups, AI data handling, and deployment configuration.

## Secret handling

- Never commit `.env`, API keys, passwords, database files, or production backups.
- Rotate any secret that may have been exposed.
- Use separate credentials and databases for local, staging, and production environments.
