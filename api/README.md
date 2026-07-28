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

## Per-check notification routing

`CheckModel.notificationChannelIds` lists the enabled notification channels
that currently receive future transitions for the check. New and existing
checks default to all enabled channels in their project; exclusions are stored
only when a channel is turned off for a particular check, so newly created
enabled channels are included automatically.

Use the idempotent GraphQL mutation
`setCheckChannelEnabled(checkId: ID!, channelId: ID!, enabled: Boolean!)` to
change one channel. The channel must be enabled and belong to the check's
project. Repeating the same value is safe, including disabling every channel.
Changing routing does not send notifications, create alert logs, or enqueue
escalation work. Moving a check to another project clears its exclusions, so
the destination project's enabled channels become the new defaults.

Recipient routing is snapshotted atomically when a check transitions to
`DOWN` or recovers from `DOWN` to `UP`. Later per-check channel changes affect
only future transitions; already queued jobs retain their original recipients.
Consumers may still skip a snapshotted channel if it is deleted or globally
disabled before delivery.
