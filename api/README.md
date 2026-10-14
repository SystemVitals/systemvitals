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

## Account personal access tokens

With a non-impersonated session JWT, call
`createPersonalAccessToken(name: String!, expirationDays: Int)` and save its
`plaintext` field from that one response. Omit expirationDays (or pass null) for
no expiration; supplied values must be integers from 1 to 3650. Only the hash and
identifying prefix are stored. List metadata with `apiTokens` and revoke with
`revokeApiToken`, both session-only.

Use the returned secret as `Authorization: Bearer svt_...` on `/graphql`.
`apiCredential` reports mode `ACCOUNT`, `account:manage`, and effective check
capabilities with no organization binding. Current membership, roles, ownership,
plan limits and handshake requirements still apply. Account tokens can manage
public product resources, move checks and query allowance. Password changes,
token administration and `/admin/graphql` remain excluded, even for admin issuers.
Expired, revoked, suspended-account and malformed credentials are rejected.

`createBillingCheckout(plan: String!, interval: String)` accepts SIGNAL/FLEET
and month/year (default month); `createBillingPortal` returns the account's
hosted billing portal. Both return `{ url }`, require a non-impersonated session
or account PAT, and reuse BillingService. The user completes changes on Stripe's
hosted pages. Existing session-only REST billing endpoints remain compatible.
Scoped and legacy credentials do not gain account permissions.

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
notification work. Moving a check to another project clears its exclusions, so
the destination project's enabled channels become the new defaults.

Selected channels receive notifications when a check transitions to `DOWN` and
when it later recovers from `DOWN` to `UP`. Recipient routing is resolved
while the producer holds the transition transaction's database lock. After the
status and event commit, the producer carries those IDs in memory into the
queued job. PostgreSQL and Redis are not joined by a transactional outbox, so
an enqueue failure can leave a committed transition without a notification
job. Later per-check channel changes affect only future transitions; already
queued jobs retain their original recipients. Consumers may still skip a
snapshotted channel if it is deleted or globally disabled before delivery.

## Error monitoring

Sentry project: `nexus/systemvitals-api` at https://sentry.nihey.org. Set
`SENTRY_DSN` and `SENTRY_ENVIRONMENT` in the deployment environment. A blank
DSN disables monitoring; tests never send events. Error events omit request
data, user identity, and breadcrumbs. Tracing and SDK logs are disabled.

Error payloads omit extra data and replace exception messages (including causes) with a generic value; stack frames and error types remain available. Node services retain fatal unhandled rejections and flush before controlled exits.
