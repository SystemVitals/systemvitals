# SystemVitals

[![CI](https://github.com/SystemVitals/systemvitals/actions/workflows/ci.yml/badge.svg)](https://github.com/SystemVitals/systemvitals/actions/workflows/ci.yml)

<p align="center">
  <img src="frontend/app/icon.svg" width="96" alt="SystemVitals logo">
</p>

SystemVitals is an open-source uptime and cron-job monitoring platform. It
combines passive heartbeat monitoring with active HTTP, TCP, and ping checks,
per-check notification routing, public status pages, and an MCP integration.

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

The Next.js frontend communicates with the NestJS API, which stores monitoring
data in PostgreSQL and schedules background work through Redis and BullMQ. An
organization is the sole public workspace; one internal project per
organization preserves existing relational and worker contracts. The worker
performs probes and delivers alerts. The Prisma package is the shared database
schema source of truth. See
[the architecture reference](docs/ARCHITECTURE.md).

## Notification routing

Each check selects from the globally enabled notification channels in its
organization workspace. Selected channels receive a notification only when a
future monitoring event changes the check to `DOWN`, and again when it actually
recovers from `DOWN` to `UP`. Changing a selection does not send a notification
for the check's current state.

All enabled organization channels are selected by default. Channels enabled
later also become selected unless they were explicitly turned off for that
check. The dashboard and check detail page let users turn individual channels
on or off, including turning every channel off with a clear
`Notifications off` warning.

## Organization workspace compatibility

This compatibility release makes the organization the only public workspace.
Organization creation automatically provisions its one internal project, and
the public `createProject` operation has been removed. New GraphQL and MCP
clients use `organizationId`; deprecated `projectId` inputs, fields, and tools
remain functional for this release only. Existing project-scoped API tokens
continue to work unchanged.

Before upgrading a self-hosted installation, run the read-only workspace
preflight:

```bash
cd database
npm run preflight:organization-workspaces
```

If any organization has zero or multiple internal projects, both the preflight
and migration abort without writes. Reconcile that data deliberately before
retrying; the migration never selects, creates, merges, moves, or deletes
workspace data automatically. The next cleanup release removes the deprecated
public project surface, but does not necessarily remove the internal project
table.

## Self-hosting

See [deployment documentation](docs/DEPLOYMENT.md) for Docker Compose and zero-downtime Dokploy deployment options.

## Contributing and support

- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Support](SUPPORT.md)
- [Apache-2.0 license](LICENSE)
