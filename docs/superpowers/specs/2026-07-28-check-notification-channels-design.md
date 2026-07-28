# Per-Check Notification Channels Design

**Date:** 2026-07-28
**Status:** Approved

## Summary

Replace project-wide immediate fan-out plus delayed escalation policies with one
predictable rule: each check chooses which enabled project notification
channels receive its `DOWN` and recovery notifications.

Channel controls appear in both the dashboard check cards and the check detail
page. Each toggle saves immediately, shows a brief loading state, and edits the
same server-side selection from either surface.

Escalation policies and acknowledgement are removed from the live product.

## Goals

- Let a user enable or disable every project channel independently for each
  check.
- Send one notification when the check transitions to `DOWN` and one when it
  recovers from `DOWN` to `UP`.
- Preserve safe defaults: every enabled channel applies to existing and new
  checks unless explicitly disabled for that check.
- Automatically apply newly created channels to every existing check.
- Permit a check to have no notification channels, with a prominent warning.
- Keep the management action available through the public GraphQL API and MCP
  integration.
- Preserve zero-downtime Dokploy deployments while retiring escalation.

## Non-Goals

- Separate channel selections for `DOWN` and recovery.
- Notifications for every successful ping or probe.
- Sending an alert when a channel toggle changes while a check is already
  `DOWN`.
- Delays, tiers, reminders, acknowledgement, or incident workflow.
- Replacing project-level channel creation and verification.

## Product Rules

1. An enabled project channel not explicitly excluded from a check receives
   both `DOWN` and recovery notifications for that check.
2. Per-check controls list only enabled project channels. Pending or globally
   disabled channels remain managed on `/channels` and cannot be selected until
   they become enabled.
3. Existing checks begin with all currently enabled project channels selected.
4. New checks begin with all currently enabled project channels selected.
5. A newly created channel is selected for every existing check automatically.
6. Users may disable every current channel for a check.
7. If a new channel is created later, it becomes selected even for a check that
   previously had every older channel disabled.
8. Enabling a channel while a check is already `DOWN` does not send anything.
   The channel participates only in later status transitions.
9. An `UP` notification means recovery from `DOWN`, not ordinary successful
   monitoring events.

## Data Model

Store only exceptions to the default-all rule:

```prisma
model CheckChannelExclusion {
  checkId   String @map("check_id")
  channelId String @map("channel_id")

  check   Check               @relation(fields: [checkId], references: [id], onDelete: Cascade)
  channel NotificationChannel @relation(fields: [channelId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now()) @map("created_at")

  @@id([checkId, channelId])
  @@index([channelId])
  @@map("check_channel_exclusions")
}
```

`Check` and `NotificationChannel` gain the corresponding relation collections.
The composite primary key makes disabling idempotent, and cascading deletion
prevents stale configuration.

No backfill is required. An empty exclusions table preserves the current
immediate fan-out behavior for every existing check.

Moving a check to another project deletes all of its exclusions in the same
transaction before changing `projectId`. The moved check therefore adopts all
enabled channels in the destination project by default and never retains
cross-project exclusions.

## GraphQL API

`CheckModel` gains:

```graphql
notificationChannelIds: [ID!]!
```

This is the effective set of enabled project channel IDs after exclusions have
been applied.

Add the mutation:

```graphql
setCheckChannelEnabled(
  checkId: ID!
  channelId: ID!
  enabled: Boolean!
): CheckModel!
```

Mutation behavior:

- Require `checks:write` access for the check's project.
- Verify the check and channel exist and belong to the same project.
- Reject a channel that is not currently enabled.
- With `enabled: false`, upsert the exclusion.
- With `enabled: true`, delete any matching exclusion.
- Return the updated check with effective `notificationChannelIds`.
- Repeating the same request succeeds without changing the result.
- Never enqueue an alert or recovery job.

The dashboard loads project channels once and reads
`notificationChannelIds` for each check. The detail page loads the same project
channel list and the selected IDs for its check.

The MCP server adds a corresponding check-channel toggle tool and includes
effective notification channels when presenting check details.

## Worker Behavior

Each producer snapshots the effective channel IDs inside the same locked
database transaction that commits an actual status transition. This applies to
watchdog `DOWN`, probe `DOWN`/recovery, and heartbeat recovery. The resulting
alert job carries an optional `channelIds` field.

When `channelIds` is present, the snapshot is authoritative, including an empty
array. At consumption time the worker still verifies that each referenced
channel exists, belongs to the check's current project, and remains globally
enabled, but it does not reapply exclusions changed after the transition.
Snapshotless jobs from an older producer resolve the current exclusions at
processing time only for rolling-deployment compatibility.

The existing per-channel isolation and `AlertLog` behavior remain: one failed
channel does not block another, and each attempt records its result.

The worker sends only:

- `kind: down` after an actual transition to `DOWN`;
- `kind: recovery` after an actual transition from `DOWN` to `UP`.

It no longer schedules escalation work after immediate `DOWN` dispatch.
Changing exclusions never changes an already-queued transition: a later toggle
neither adds recipients to nor suppresses its snapshot. Toggle changes affect
future status transitions only.

## User Interface

### Shared presentation

A shared frontend helper/component maps channel type to icon and safe display
text so the two surfaces cannot drift:

- Email: `Mail`
- Telegram: `Send`
- Webhook: `Webhook`
- Legacy Slack records: `MessageSquare`
- Unknown future type: `Bell`

Icons supplement, but never replace, the text label. Destination summaries use
the already sanitized channel configuration:

- email address for email;
- chat title, then chat ID as fallback, for Telegram;
- masked host for webhook and legacy Slack.

### Dashboard

Each check card contains a compact **Notifications** section below its
monitoring metadata. It lists every enabled project channel with a type icon,
label, and switch. The section states that the selection applies to
`DOWN + RECOVERY`.

### Check detail

Add a full-width **Notifications** card before recent events. Each row contains:

- channel-type icon;
- type and destination summary;
- selection switch.

### Toggle interaction

- A switch changes visually and saves immediately.
- Only the switch being changed is disabled while its mutation is pending.
- A short `Saving…` indicator is visible.
- Success updates Apollo's shared check state so dashboard and detail views
  remain consistent.
- Failure restores the previous value and opens the standard shadcn error
  dialog.
- Switches have explicit accessible labels containing the check and channel
  names.

### Empty and silent states

If the project has no enabled channels, both surfaces show **No active
notification channels** with an **Add or activate a notification channel** link
to `/channels`.

If every current channel is disabled for a check, both surfaces show:

> Notifications off — This check will not send DOWN or RECOVERY notifications.

Creating a new channel later selects it automatically and removes this warning
for that check.

## Escalation and Acknowledgement Removal

The final product removes:

- `/escalation` and its sidebar entry;
- escalation GraphQL queries and mutations;
- escalation scheduling and processing in the worker;
- the check `Acknowledge` action and acknowledgement GraphQL mutation;
- escalation and acknowledgement references in MCP documentation;
- product copy, marketing claims, architecture documentation, and tests that
  describe delayed escalation or acknowledgement.

Historical `AlertLog` rows remain unchanged.

The first functional removal does not immediately drop
`escalation_policies` or `acknowledgements`, and it does not immediately remove
the Redis escalation queue configuration. These become dormant compatibility
artifacts during the zero-downtime rollout. A later cleanup migration removes
them after no old worker can reference them.

## Rollout

Use protected pull requests and the existing serialized Dokploy deployment
chain.

### Release 1: compatibility foundation

- Add the exclusions table and relations.
- Add the GraphQL field and mutation.
- Make every DOWN/recovery producer snapshot effective recipients in its
  locked transition transaction.
- Make the worker consume authoritative snapshots while retaining
  snapshotless-job compatibility.
- Add API, database, and worker tests, including post-enqueue toggle and
  transition/toggle concurrency cases.
- Do not expose frontend toggles yet.
- Keep escalation and acknowledgement behavior available.

Because no exclusion rows exist initially, production behavior is unchanged.
After this release, every running worker understands exclusions.

### Release 2: product simplification

- Add dashboard and detail-page controls.
- Add the MCP operation.
- Remove escalation and acknowledgement from UI and public API.
- Stop scheduling and consuming escalation jobs.
- Update product and architecture documentation.
- Keep legacy tables and queue configuration dormant.

The old worker overlapping this deployment is already the Release 1 worker and
therefore respects exclusions before the frontend can create them.

### Release 3: compatibility cleanup

After a successful observation window confirms that no old worker remains:

- remove dormant Prisma models and apply the table-dropping migration;
- remove the escalation queue registration and obsolete environment/config
  references;
- remove remaining compatibility tests and code.

Infrastructure Compose remains untouched throughout these application
deployments.

## Error Handling

- Unknown check or channel: return `NotFound`.
- Cross-project channel assignment: reject without revealing inaccessible
  resource details.
- Missing write scope or organization membership: use existing authorization
  behavior.
- Duplicate disable or repeated enable: succeed idempotently.
- Frontend network/server error: revert only the affected switch and show the
  standard error dialog.
- Channel removed between query and mutation: refetch the channel list after
  reporting the error.
- Notification dispatch failure: retain current per-channel logging and retry
  semantics.

## Testing

### Database

- Composite exclusion uniqueness.
- Cascade on check deletion.
- Cascade on channel deletion.
- Check move clears source-project exclusions.
- No-backfill migration preserves default-all behavior.

### API

- Effective IDs include all eligible channels by default.
- Disable creates one exclusion; enable removes it.
- Mutation is idempotent.
- All channels may be excluded.
- A later channel automatically appears in effective IDs.
- Cross-user and cross-project mutations are rejected.
- API-token read/write scopes follow existing check policy.
- Toggle mutations never enqueue notifications.
- Escalation and acknowledgement operations are absent after Release 2.

### Worker

- `DOWN` dispatch reaches selected channels only.
- Recovery dispatch reaches the same selected channels only.
- Watchdog, probe, and heartbeat recovery snapshot effective channel IDs in the
  same locked transaction as the actual transition.
- A present job snapshot, including `[]`, is not changed by later per-check
  toggles.
- Snapshot consumption rechecks channel existence, project membership, and
  global enabled state without reapplying later exclusions.
- Snapshotless legacy jobs resolve current exclusions for rolling
  compatibility.
- All-off produces no dispatch or `AlertLog`.
- Globally disabled/ineligible channels do not dispatch.
- Toggle changes do not notify an already-down check.
- Post-enqueue toggle and transition/toggle concurrency cases preserve the
  transition-time recipient set.
- Existing notifier failure isolation and retries remain.
- Release 2 schedules no escalation jobs.

### Frontend

- Dashboard and detail views render the same effective selection.
- Correct icon and sanitized destination label per channel type.
- Immediate save and per-switch loading state.
- Successful mutation updates both cached surfaces.
- Failed mutation reverts and opens the error dialog.
- No-channel call to action.
- All-off warning.
- Escalation navigation/page and acknowledgement action are absent.
- Keyboard and screen-reader labels for every switch.

### MCP and integration

- Tool validates input and calls the public mutation.
- Check presentation includes effective channel IDs.
- Full CI, production image builds, and deployment smoke checks pass for each
  rollout release.

## Documentation

Update:

- root, API, frontend, worker, database, and MCP `CLAUDE.md` files;
- `README.md` feature descriptions;
- `docs/ARCHITECTURE.md`;
- frontend marketing copy;
- environment/deployment documentation when the queue is removed in Release 3.

Documentation must describe per-check `DOWN` and recovery notification
selection and must not claim that escalation or acknowledgement remains
available after Release 2.

## Acceptance Criteria

- Every dashboard check card and check detail page can toggle each project
  channel independently.
- Toggles save immediately with visible loading and safe rollback on failure.
- Selected channels receive exactly the check's `DOWN` and recovery
  notifications.
- Unselected channels receive neither.
- Existing checks, new checks, and newly created channels default to selected.
- All channels can be disabled with an explicit warning.
- No configuration change sends a retroactive notification.
- Escalation and acknowledgement are absent from the live product.
- Public API and MCP clients can manage the same configuration.
- Dokploy application deployments remain zero-downtime and do not deploy or
  recreate infrastructure services.
