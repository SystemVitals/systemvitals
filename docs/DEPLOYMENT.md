# Deployment

SystemVitals supports two deployment modes. Store credentials in your deployment platform or an untracked environment file; never add production values to this repository.

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

### Serialized application releases

For Release 2, deploy automatically from the merged `main` commit in this
order:

1. API
2. Frontend
3. Worker

Wait for each application's readiness gate to pass before starting the next
deployment. If a gate fails, stop the sequence and roll back that application.
Release 2 is application-only: do not modify, restart, or deploy the
infrastructure Compose project.

For the existing production environment, `../nihey/.env` remains the
authoritative infrastructure environment source. It is intentionally outside
this public repository. Deployment automation may load it in memory, but must
never copy it into this checkout, print its values, add its values to tests or
logs, or commit it. Other installations should use their own equivalently
protected external environment source.

## Operational checks

Before and after every deployment:

1. Confirm database backups are current and restorable.
2. Confirm migrations complete before application readiness is declared.
3. Check the API `/health/ready` and frontend `/api/health` endpoints.
4. Confirm the worker readiness health check is healthy and that a test check can be processed.

Use least-privilege deployment credentials and rotate any credential that may have been exposed.
