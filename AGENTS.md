# SystemVitals contributor guide

SystemVitals is a Node.js 22 monorepo. Use npm in every project; this repository does not use a root workspace.

Run validation from the relevant directory:

- `database/`: `npm ci && npm test`
- `api/`: `npm ci && npm run lint && npx tsc --noEmit && npm test && npm run test:e2e`
- `frontend/`: `npm ci && npm run lint && npx tsc --noEmit && npm test`
- `worker/`: `npm ci && npx tsc --noEmit && npm test`
- `integrations/mcp/`: `npm ci && npx tsc --noEmit && npm test`

Docker build contexts are intentional: build the API and worker from the repository root (`-f api/Dockerfile .` and `-f worker/Dockerfile .`), and build the frontend from `frontend/` (`-f frontend/Dockerfile frontend`).

Never commit credentials, production data, generated keys, or local `.env` files. Keep `.env.example` files limited to safe placeholders. The `docker-compose.infrastructure.yml` file is a generic stateful infrastructure template and must never contain production values, identifiers, hosts, or credentials.

Keep pull requests focused, add tests for behavior changes, and update public documentation when a user-visible workflow, deployment contract, or API changes.
