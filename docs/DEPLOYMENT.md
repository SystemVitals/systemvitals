# Deployment

SystemVitals supports two deployment modes. Store credentials in your deployment platform or an untracked environment file; never add production values to this repository.

## Compatibility-release upgrade preflight

An organization is now the sole public workspace, backed by exactly one
internal project. Before upgrading any self-hosted installation to this
compatibility release, run the read-only preflight against its PostgreSQL
database:

```bash
cd database
npm run preflight:organization-workspaces
```

The preflight reports organizations with zero or multiple internal projects
and does not write data. The deployment migration repeats the same guard and
aborts without writes when it finds incompatible data. Reconcile such data
deliberately before retrying; neither path selects a project, creates a missing
one, merges or moves resources, or deletes data automatically.

The public `createProject` operation is removed. New clients use
`organizationId`; deprecated `projectId` inputs and fields remain functional
for this release only, and existing project-scoped API tokens remain valid.
The next cleanup release removes the deprecated public project surface but does
not automatically delete the internal project table.

## Generic self-hosting

`docker-compose.prod.yml` runs PostgreSQL, Redis, API, worker, and frontend as one stack. Create a protected `.env.production` with the required values, then:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

The API and worker images are built with the repository root as their Docker context. The frontend image is built with `frontend/` as its context. Back up the PostgreSQL volume before upgrades, apply changes one release at a time, and verify the API and frontend health endpoints after each rollout.

## Generic zero-downtime Dokploy deployment

For independent application rollouts, deploy the stateful infrastructure and applications separately:

| Component | Configuration | Readiness |
| --- | --- | --- |
| Infrastructure | `docker-compose.infrastructure.yml`; PostgreSQL + Redis; auto-deploy disabled | service health checks |
| API | `api/Dockerfile`, repository-root context | `/health/ready` |
| Frontend | `frontend/Dockerfile`, `frontend` context | `/api/health` |
| Worker | `worker/Dockerfile`, repository-root context | readiness-marker Docker health check |

Keep the infrastructure Compose deployment stateful and set its auto-deploy to disabled. Its compose file must remain free of production values. Configure the API, frontend, and worker as three applications that automatically deploy from `main`.

Each application should run one replica, use a start-first update order, and roll back when its health check fails. The worker has no public HTTP route; its Docker health check validates the readiness marker. Use the documented API and frontend readiness paths when configuring application health checks.

### Automatic triggers and required release order

The API, frontend, and worker are independent applications, each configured to
auto-deploy when `main` changes. Repository provisioning enables each
application's `autoDeploy` flag independently; it does not define cross-app
dependencies or readiness ordering.

Use this application release order:

1. API
2. Frontend
3. Worker

Merging to `main` still triggers all three applications automatically. Observe
the Dokploy deployment queue and application status during every release.
The API must reach `/health/ready` before the frontend rolls out, and the
frontend must reach `/api/health` before the worker rolls out. If the order
differs, deployments overlap, or a readiness gate fails, intervene manually to
stop the later rollout and roll back the failed application before continuing.
This compatibility release does not change stateful infrastructure: do not
modify, deploy, or restart the infrastructure Compose project.

### Active worker queues

The worker uses four queues: `probe` for scheduled checks, `alert` for
transition notifications, `invite` for organization invitations, and
`email-verification` for email-channel verification. Dokploy provisioning
allows queue-name overrides only for `probe`, `alert`, and `invite`; it keeps
the email-verification queue at the shared `email-verification` default.
Keep any allowlisted override aligned between its producers and the worker.

For the existing production environment, `../nihey/.env` remains the
authoritative infrastructure environment source. It is intentionally outside
this public repository. Deployment automation may load it in memory, but must
never copy it into this checkout, print its values, add its values to tests or
logs, or commit it. Other installations should use their own equivalently
protected external environment source.

## Account PAT rollout

Deploy the API's `createPersonalAccessToken`, `ACCOUNT` credential discovery and
GraphQL billing-link operations before deploying the account-token frontend.
Publish the updated `@systemvitals/mcp` package before exposing its `npx` setup;
the package is currently prepared for publication but unpublished. Source-checkout
MCP and direct GraphQL access do not depend on publication. This feature reuses
existing token storage and requires no database migration or worker change.
Older API versions reject account PATs instead of treating them as legacy broad
tokens; existing scoped and legacy tokens remain compatible with the new API.

## Account overview release: outage history migrations

This release adds the first database trigger and a backfill. The API
entrypoint applies three migrations before the API is ready:

| Migration | What it does | Effect on writers |
| --- | --- | --- |
| `20261104120000_check_outages` | Creates `check_outages`, the `checks_record_outage` trigger, and a backfill cutoff | Waits briefly for in-flight status writes |
| `20261104120100_backfill_check_outages` | Rebuilds outage history from `check_events` | See below |
| `20261104120200_check_outages_ended_at_index` | Indexes `check_outages (check_id, ended_at)` for the overview query | Pauses status changes while it builds over the (small) outage table |

From the first migration on, every write that changes `checks.status` (worker
probes and watchdog, pings, pause and resume, type changes, admin actions, and
manual SQL) also opens or closes a `check_outages` row through
`checks_record_outage`. Writes that leave the status unchanged do nothing extra.

The backfill runs in one transaction with no `lock_timeout`:

1. **Phase (a)** scans all of `check_events` into a temporary staging table.
   It only reads, so probes, pings, and status writes continue.
2. **Phases (b)–(e)** lock `checks` (`FOR KEY SHARE` on every row, then
   `SHARE ROW EXCLUSIVE`). Until the commit, status writes and pings wait while
   the staged outages are inserted and overlapping outages are merged. This
   pause grows with outage history, not with the total number of events.
   Without a `lock_timeout`, the lock also waits behind any long-running
   transaction that touches `checks`, and writers queue behind it.

Size the release before deploying. Rehearse on a restored backup for a real
timing:

```sql
-- Rows phase (a) scans (writers keep running) and an upper bound for outages.
SELECT count(*) AS events,
       count(*) FILTER (WHERE status = 'DOWN') AS down_events
FROM check_events;

-- Roughly the outage rows inserted while writers wait: one per run of
-- consecutive DOWN events. Probe gaps (pauses) split a few more.
SELECT count(*) AS estimated_outages
FROM (
  SELECT status,
         lag(status) OVER (PARTITION BY check_id ORDER BY "timestamp", id) AS previous
  FROM check_events
) e
WHERE status = 'DOWN' AND previous IS DISTINCT FROM 'DOWN';

-- Long-running transactions the table lock would queue behind.
SELECT pid, now() - xact_start AS open_for, state, left(query, 80) AS query
FROM pg_stat_activity
WHERE datname = current_database() AND xact_start < now() - interval '1 minute';
```

The API image's health check allows a 31-minute start period, which covers
migrations. If the container is stopped mid-backfill, the transaction rolls
back; recover as for a failure, below.

**If the backfill fails**, for example when it is chosen as a deadlock victim
because an organization or project delete cascades over several checks while
the backfill takes its row locks, the transaction rolls back cleanly. The first
migration has already committed, so the trigger keeps recording new outages and
the previous API keeps serving. Prisma marks the backfill as failed and refuses
later deploys until it is resolved. From `database/`, with `DATABASE_URL`
pointing at the production database:

```bash
npx prisma migrate resolve --rolled-back 20261104120100_backfill_check_outages
```

Then redeploy the API. The re-run reuses the original cutoff, leaves outages
recorded since then to the trigger, and merges any overlap.

The overview requires **PostgreSQL 16 or later**: its buckets use the
time-zone-aware `generate_series(start, stop, step, time_zone)`. The bundled
Compose files and CI pin PostgreSQL 18. On older servers the migrations
succeed, but `accountOverview` requests fail.

## Operational checks

Before and after every deployment:

1. Confirm database backups are current and restorable.
2. Confirm migrations complete before application readiness is declared.
3. Check the API `/health/ready` and frontend `/api/health` endpoints.
4. Confirm the worker readiness health check is healthy and that a test check can be processed.

Use least-privilege deployment credentials and rotate any credential that may have been exposed.

## Sentry source-map uploads

The frontend builder installs the system CA bundle so the native Sentry CLI can
verify HTTPS when uploading source maps. Pass the upload token only through the
`SENTRY_SELF_HOSTED_AUTH_TOKEN` BuildKit secret; never add it to image environment
variables or disable TLS verification. A successful Next.js build alone does not
confirm an upload: check the project artifact-bundle inventory after deployment.
