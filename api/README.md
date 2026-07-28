# SystemVitals API

The API is a NestJS service that exposes the SystemVitals GraphQL API, REST authentication and heartbeat endpoints, billing webhooks, and readiness checks. It uses PostgreSQL through `@systemvitals/database` and Redis for background queues.

## Development

Copy `.env.example` to `.env` and provide local development values before starting the service. Never commit a populated `.env` file.

```bash
npm ci
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e
```

Run `npm run start:dev` to start the API locally on port 8888. The API requires PostgreSQL and Redis; `../dev.sh` starts the local infrastructure.
