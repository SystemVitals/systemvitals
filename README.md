# SystemVitals

<p align="center">
  <img src="frontend/app/icon.svg" width="96" alt="SystemVitals logo">
</p>

SystemVitals is an open-source uptime and cron-job monitoring platform. It combines passive heartbeat monitoring with active HTTP, TCP, and ping checks, notifications, escalation policies, public status pages, and an MCP integration.

Visit [systemvitals.link](https://systemvitals.link) or clone the project:

```bash
git clone https://github.com/SystemVitals/systemvitals.git
cd systemvitals
```

## Prerequisites

- Node.js 22
- npm
- Docker (for PostgreSQL and Redis)
- tmux (for `./dev.sh`)

## Local development

Copy the example environment files before starting services. Keep real values in untracked `.env` files.

```bash
cp api/.env.example api/.env
cp frontend/.env.example frontend/.env
cp worker/.env.example worker/.env
./dev.sh
```

`./dev.sh down` stops the local stack.

## Install and test

Run commands from each project directory:

| Project | Install | Validate |
| --- | --- | --- |
| `database` | `npm ci` | `npm test` |
| `api` | `npm ci` | `npm run lint && npx tsc --noEmit && npm test && npm run test:e2e` |
| `frontend` | `npm ci` | `npm run lint && npx tsc --noEmit && npm test` |
| `worker` | `npm ci` | `npx tsc --noEmit && npm test` |
| `integrations/mcp` | `npm ci` | `npx tsc --noEmit && npm test` |

## Architecture

The Next.js frontend communicates with the NestJS API, which stores monitoring data in PostgreSQL and schedules background work through Redis and BullMQ. The worker performs probes and delivers alerts. The Prisma package is the shared database schema source of truth. See [the architecture reference](docs/ARCHITECTURE.md).

## Self-hosting

See [deployment documentation](docs/DEPLOYMENT.md) for Docker Compose and zero-downtime Dokploy deployment options.

## Contributing and support

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Apache-2.0 license](LICENSE)
