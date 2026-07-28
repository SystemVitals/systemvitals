# SystemVitals worker

The worker is the BullMQ monitoring engine. It schedules and runs active
probes, detects overdue heartbeats, processes transition alerts, and handles
supporting background jobs such as invitations and email verification.

## Alert delivery

Recipients are snapshotted when a check transitions. The effective recipient
set is the check's enabled project channels minus that check's channel
exclusions. An empty exclusion set therefore selects every enabled channel,
including channels added after the check was created.

Alert consumption uses that snapshot instead of re-reading check exclusions,
so later routing toggles affect only future transitions. A channel that was
deleted or globally disabled after the transition is safely skipped. During a
rolling upgrade, legacy queued jobs without a snapshot temporarily resolve
recipients from the current exclusions.

DOWN transitions send an immediate alert to every selected channel. Recovery
notifications use the same selection rule and are sent only for an actual
DOWN-to-UP transition. Each channel is attempted independently and gets its own
successful or failed `AlertLog`, so one notifier failure does not block another
channel.

Release 1 temporarily continues to schedule the legacy escalation policy after
immediate DOWN delivery. Recovery notifications do not schedule escalation.

## Validation

From `worker/`, install and validate with:

```sh
npm ci
npx tsc -p tsconfig.build.json --noEmit
npm test
```

Database-backed tests require a PostgreSQL database with all migrations applied.
