# Per-Check Notification Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace escalation policies and acknowledgements with immediate per-check notification-channel routing for DOWN and recovery transitions, while preserving automatic zero-downtime Dokploy deployments.

**Architecture:** Store only `(check_id, channel_id)` exclusions so every enabled project channel is selected by default, including channels enabled later. Expose the effective enabled channel IDs through GraphQL, mutate one channel at a time with project-scoped authorization, filter worker delivery by exclusions, and use one shared frontend control on dashboard cards and check detail pages. Roll out in three protected releases: compatible foundation, product cutover, then dormant-schema/infrastructure cleanup.

**Tech Stack:** PostgreSQL + Prisma, NestJS GraphQL, BullMQ worker, Next.js 16 + React 19 + TypeScript + Apollo Client 4 + Tailwind CSS v4 + shadcn/ui + lucide-react, Vitest/Jest, npm on Node.js 22, GitHub Actions, Dokploy.

## Global Constraints

- Notify only on future `UP -> DOWN` and `DOWN -> UP` transitions. Do not notify for ordinary successful probes and do not emit a notification when a channel is enabled while a check is already DOWN.
- One per-check selection controls both DOWN and recovery delivery. There is no separate recovery toggle.
- Effective selection is `enabled project channels - check exclusions`. New checks and newly enabled channels therefore default to selected without backfills.
- A check may exclude every channel. The UI must make that state explicit with `Notifications off`.
- Disabled and pending-verification channels are not effective selections and do not appear in per-check controls.
- Channel icons are `Mail` for EMAIL, `Send` for TELEGRAM, `Webhook` for WEBHOOK, `MessageSquare` for legacy SLACK, and `Bell` for unknown future types.
- Toggle writes save immediately, show a brief per-channel pending state, prevent duplicate writes for that channel, and revert only that channel on failure before opening the standard shadcn error dialog.
- Dashboard and check detail controls share one implementation. The dashboard queries channels once per project rather than once per card.
- Keep channel credentials sanitized. Every query and mutation must enforce project ownership and scoped-token permissions without revealing cross-project resource existence.
- Use GraphQL for application data operations; do not add REST endpoints.
- Update affected `CLAUDE.md`, README, architecture, MCP, and deployment documentation in the release that changes behavior.
- Each release is a separate protected pull request. Required checks are `database / api / worker`, `frontend`, `deployment images`, and `integrations/mcp`.
- Dokploy deploys API, then frontend, then worker from the public repository after merge. Do not trigger or modify the infrastructure Compose deployment.
- Preserve `../nihey/.env` and every untracked or ignored secret file. Never copy secret values into the public repository, tests, logs, commits, or GitHub configuration.

---

## Release 1 — Compatible Data, API, and Worker Foundation

### Task 1: Add the exclusion table and Prisma relations

**Files:**

- Modify: `database/prisma/schema.prisma`
- Create: `database/prisma/migrations/20260728160000_check_channel_exclusions/migration.sql`
- Create: `database/test/check-channel-exclusions-migration.test.ts`
- Create: `database/test/check-channel-exclusions.test.ts`
- Modify: `database/CLAUDE.md`

**Interfaces:**

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

Add `channelExclusions CheckChannelExclusion[]` to `Check` and `checkExclusions CheckChannelExclusion[]` to `NotificationChannel`.

- [ ] Create a failing migration test that reads the new SQL and asserts the composite primary key, both cascading foreign keys, the `channel_id` index, and the absence of any INSERT/backfill statement.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL(
    "../prisma/migrations/20260728160000_check_channel_exclusions/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

describe("check channel exclusions migration", () => {
  it("creates an empty cascading exclusion join table", () => {
    expect(sql).toContain('CREATE TABLE "check_channel_exclusions"');
    expect(sql).toContain('PRIMARY KEY ("check_id","channel_id")');
    expect(sql).toContain('ON DELETE CASCADE ON UPDATE CASCADE');
    expect(sql).toContain(
      'CREATE INDEX "check_channel_exclusions_channel_id_idx"',
    );
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });
});
```

- [ ] Run `npm test -- check-channel-exclusions-migration.test.ts` from `database/` and confirm it fails because the migration does not exist.
- [ ] Add the Prisma model and inverse relations exactly as specified.
- [ ] Create a transactional SQL migration that creates the empty table, index, and foreign keys to `checks(id)` and `notification_channels(id)` with cascading deletes.
- [ ] Add a database contract test that creates one check and two channels, rejects a duplicate composite exclusion, cascades exclusions when the check is deleted, recreates the check/exclusion, and cascades when the channel is deleted. Use unique IDs and clean up the owning organization/user in `afterAll`.
- [ ] Document the exclusion-based default semantics in `database/CLAUDE.md`.
- [ ] Run `npm run generate`, `npx prisma validate`, and `npm test -- check-channel-exclusions-migration.test.ts check-channel-exclusions.test.ts` from `database/`.
- [ ] Commit:

```bash
git add database/prisma database/test/check-channel-exclusions-migration.test.ts database/test/check-channel-exclusions.test.ts database/CLAUDE.md
git commit -m "feat(database): add check channel exclusions"
```

### Task 2: Expose effective channel IDs efficiently in GraphQL

**Files:**

- Modify: `api/src/checks/check.model.ts`
- Modify: `api/src/checks/checks.resolver.ts`
- Modify: `api/src/checks/checks.service.ts`
- Modify: `api/src/checks/checks.service.spec.ts`
- Modify: `api/src/checks/checks.resolver.spec.ts`
- Modify: `api/src/schema.gql`

**Interfaces:**

```graphql
type CheckModel {
  notificationChannelIds: [ID!]!
}
```

```ts
type CheckWithNotificationChannels<T> = T & {
  notificationChannelIds: string[];
};

effectiveNotificationChannelIds(
  checkId: string,
  projectId: string,
  tx?: Prisma.TransactionClient,
): Promise<string[]>;
```

- [ ] Add service tests proving that effective IDs contain only enabled channels in the same project, exclude matching exclusion rows, return an empty array when all enabled channels are excluded, and ignore disabled/pending-verification channels.
- [ ] Add a list-service test proving the implementation loads active project channels in one batched query and does not query once per check.
- [ ] Run `npm test -- checks.service.spec.ts` from `api/` and confirm the new tests fail.
- [ ] Add an undecorated optional `notificationChannelIds?: string[]` presentation property to `CheckModel`.
- [ ] Implement `effectiveNotificationChannelIds()` with:

```ts
const channels = await client.notificationChannel.findMany({
  where: {
    projectId,
    enabled: true,
    checkExclusions: { none: { checkId } },
  },
  orderBy: { createdAt: "asc" },
  select: { id: true },
});
return channels.map(({ id }) => id);
```

- [ ] Update list and single-check service reads to attach `notificationChannelIds`. For list reads, fetch all enabled project channels and all exclusions for the returned check IDs, then map in memory so polling remains constant-query-count.
- [ ] Add a resolver field that returns the preloaded presentation property and falls back to `effectiveNotificationChannelIds()` only for mutation return objects that were not presented by a read path.

```ts
@ResolveField(() => [ID])
notificationChannelIds(@Parent() check: CheckModel) {
  if (check.notificationChannelIds) return check.notificationChannelIds;
  return this.checksService.effectiveNotificationChannelIds(
    check.id,
    check.projectId,
  );
}
```

- [ ] Add resolver tests for the preloaded path and fallback path.
- [ ] Regenerate `api/src/schema.gql` with the repository’s normal API build/test flow.
- [ ] Run `npm test -- checks.service.spec.ts checks.resolver.spec.ts` and `npm run build` from `api/`.
- [ ] Commit:

```bash
git add api/src/checks api/src/schema.gql
git commit -m "feat(api): expose check notification channels"
```

### Task 3: Add the idempotent channel toggle and move reset

**Files:**

- Modify: `api/src/checks/checks.resolver.ts`
- Modify: `api/src/checks/checks.service.ts`
- Modify: `api/src/checks/checks.service.spec.ts`
- Modify: `api/src/checks/checks.resolver.spec.ts`
- Modify: `api/src/tokens/token-policy.ts`
- Modify: `api/src/tokens/token-policy.spec.ts`
- Modify: `api/test/move-check.e2e-spec.ts`
- Create: `api/test/check-notification-channels.e2e-spec.ts`
- Modify: `api/src/schema.gql`
- Modify: `api/CLAUDE.md`

**Interfaces:**

```graphql
type Mutation {
  setCheckChannelEnabled(
    checkId: ID!
    channelId: ID!
    enabled: Boolean!
  ): CheckModel!
}
```

```ts
setCheckChannelEnabled(
  userId: string,
  checkId: string,
  expectedProjectId: string,
  channelId: string,
  enabled: boolean,
): Promise<CheckModel>;
```

- [ ] Add service tests for disable-upsert idempotency, enable-delete idempotency, cross-project channel rejection as not found, disabled-channel rejection, stale expected-project rejection, and a returned effective ID list reflecting the committed write.
- [ ] Add resolver tests proving `checks:write` is required for the check’s current project and that the service receives the resolved expected project ID.
- [ ] Add token-policy tests classifying `setCheckChannelEnabled` as a check write operation.
- [ ] Run the targeted API unit tests and confirm the new cases fail.
- [ ] Register `setCheckChannelEnabled` in `SCOPED_TOKEN_OPERATIONS` with `checks:write`.
- [ ] Implement the resolver by resolving `projectIdForCheck(checkId)`, calling `requireCheckAccess(principal, "checks:write", projectId)`, then passing that project ID as the service’s compare-and-set expectation.
- [ ] Implement the service mutation inside the existing creator-stable/expected-project transaction:

```ts
const channel = await tx.notificationChannel.findFirst({
  where: { id: channelId, projectId: check.projectId },
  select: { id: true, enabled: true },
});
if (!channel) throw new NotFoundException("Notification channel not found");
if (!channel.enabled) {
  throw new BadRequestException("Notification channel is not enabled");
}

if (enabled) {
  await tx.checkChannelExclusion.deleteMany({
    where: { checkId, channelId },
  });
} else {
  await tx.checkChannelExclusion.upsert({
    where: { checkId_channelId: { checkId, channelId } },
    create: { checkId, channelId },
    update: {},
  });
}
```

- [ ] Return the check with effective IDs queried through the same transaction; do not enqueue alerts, recoveries, probes, or escalation jobs.
- [ ] In `moveCheck`, delete all `checkChannelExclusion` rows for the check in the same transaction before changing `projectId`. Add unit and e2e assertions that the destination project starts with every enabled destination channel selected.
- [ ] Add GraphQL e2e coverage for query defaults, a channel created later, disable, repeated disable, enable, repeated enable, all-off, disabled channel rejection, cross-user denial, cross-project non-disclosure, scoped-token read and write behavior, and no notification/escalation side effects.
- [ ] Document the mutation, exclusion semantics, and move reset in `api/CLAUDE.md`.
- [ ] Regenerate `api/src/schema.gql`.
- [ ] Run:

```bash
cd api
npm test -- checks.service.spec.ts checks.resolver.spec.ts token-policy.spec.ts
npm run test:e2e -- check-notification-channels.e2e-spec.ts move-check.e2e-spec.ts
npm run build
```

- [ ] Commit:

```bash
git add api/src api/test/check-notification-channels.e2e-spec.ts api/test/move-check.e2e-spec.ts api/CLAUDE.md
git commit -m "feat(api): manage per-check channel routing"
```

### Task 4: Filter worker delivery by check exclusions

**Files:**

- Modify: `worker/src/alert-handler.ts`
- Modify: `worker/test/alert-handler.test.ts`
- Modify: `worker/CLAUDE.md`

**Behavioral boundary:** Release 1 continues to schedule existing escalation jobs after a DOWN transition. The initial DOWN and recovery dispatch paths must already honor exclusions. This makes the database/API/worker change backward compatible with the still-deployed frontend.

- [ ] Add alert-handler tests proving:
  - a selected enabled channel receives the DOWN notification;
  - an excluded channel does not receive DOWN;
  - the same exclusion suppresses recovery;
  - a channel enabled after check creation is selected when no exclusion exists;
  - excluding every channel produces no notifier call and no `AlertLog`;
  - globally disabled channels produce no notifier call;
  - ordinary successful probes still dispatch nothing;
  - changing exclusions does not itself call a notifier;
  - one notifier failure still records its attempt and does not block another channel;
  - existing Release 1 escalation scheduling remains unchanged.
- [ ] Run `npm test -- alert-handler.test.ts` from `worker/` and confirm the exclusion tests fail.
- [ ] Change the channel query used by both DOWN and recovery transitions:

```ts
where: {
  projectId: check.projectId,
  enabled: true,
  checkExclusions: { none: { checkId: check.id } },
}
```

- [ ] Keep channel ordering and sanitized notifier inputs unchanged.
- [ ] Document that notification routing is evaluated at transition time in `worker/CLAUDE.md`.
- [ ] Run `npm test -- alert-handler.test.ts`, `npm test`, and `npx tsc -p tsconfig.build.json --noEmit` from `worker/`.
- [ ] Commit:

```bash
git add worker/src/alert-handler.ts worker/test/alert-handler.test.ts worker/CLAUDE.md
git commit -m "feat(worker): honor check channel exclusions"
```

### Task 5: Validate and ship the compatible foundation

**Files:**

- Modify only if required by validation: files already owned by Tasks 1–4

- [ ] Run the repository’s formatting commands only on files changed in Release 1. Review formatter diffs before staging so unrelated user work is never absorbed.
- [ ] Run:

```bash
cd database && npm test && npm run generate && npx prisma validate
cd ../api && npm run lint && npm test && npm run test:e2e && npm run build
cd ../worker && npm test && npx tsc -p tsconfig.build.json --noEmit
cd .. && git diff --check
```

- [ ] Inspect `git status --short`, `git diff --stat`, and `git log --oneline --decorate -5`; verify no `.env`, credentials, local databases, build output, or unrelated files are staged.
- [ ] Push the feature branch, open a protected Release 1 pull request, and wait for all required checks.
- [ ] Merge only after the required checks pass. Confirm Dokploy preserves the current API, frontend, then worker deployment order; the unchanged frontend remains compatible with the foundation.
- [ ] Run `bash scripts/smoke-zero-downtime.sh --duration 900 --interval 1 --output /tmp/systemvitals-release1-smoke.jsonl` against production during the rollout and confirm the summary reports zero failures.
- [ ] Confirm the infrastructure Compose application was not deployed or restarted.

---

## Release 2 — Product Cutover to Per-Check Routing

### Task 6: Build the shared immediate-saving channel control

**Files:**

- Create via shadcn: `frontend/components/ui/switch.tsx`
- Create: `frontend/components/app/check-notification-channels.tsx`
- Create: `frontend/test/check-notification-channels.test.tsx`
- Modify: `frontend/lib/queries.ts`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`

**Interfaces:**

```ts
export interface NotificationChannelOption {
  id: string;
  type: "EMAIL" | "TELEGRAM" | "WEBHOOK" | "SLACK" | string;
  configJson: string;
  enabled: boolean;
}

interface CheckNotificationChannelsProps {
  checkId: string;
  checkName: string;
  notificationChannelIds: string[];
  channels: NotificationChannelOption[];
  variant: "compact" | "detail";
}
```

```graphql
mutation SetCheckChannelEnabled(
  $checkId: ID!
  $channelId: ID!
  $enabled: Boolean!
) {
  setCheckChannelEnabled(
    checkId: $checkId
    channelId: $channelId
    enabled: $enabled
  ) {
    id
    notificationChannelIds
  }
}
```

- [ ] Run `npx shadcn@latest add switch` from `frontend/`, inspect generated changes, and retain only the shadcn switch plus required package metadata.
- [ ] Write component tests for EMAIL/TELEGRAM/WEBHOOK/SLACK/fallback icons, sanitized channel labels, selected state, all-off warning, no-active-channels empty state, compact/detail rendering, keyboard operation, and screen-reader labels containing both check and channel names.
- [ ] Add mutation-interaction tests proving a toggle saves immediately, only the changed switch shows a pending state, duplicate clicks on that switch are blocked, a successful mutation updates selection, and a failed mutation reverts only that channel then opens the shadcn error dialog.
- [ ] Add a concurrency test that resolves two different channel mutations out of order and proves neither result overwrites the other channel.
- [ ] Add a shared-cache test with compact and detail controls backed by the same normalized `CheckModel`; after success, both surfaces must show the new value.
- [ ] Add a removed-channel failure test proving the component reverts the switch, opens the error dialog, and refetches active `CHANNELS` observable queries so a deleted/disabled row disappears.
- [ ] Run `npm test -- check-notification-channels.test.tsx` and confirm the tests fail.
- [ ] Implement the shared component with lucide icons and accessible labels:

```ts
const channelIcons = {
  EMAIL: Mail,
  TELEGRAM: Send,
  WEBHOOK: Webhook,
  SLACK: MessageSquare,
} as const;
const Icon = channelIcons[channel.type as keyof typeof channelIcons] ?? Bell;
```

- [ ] Filter to `channel.enabled`, keep a `Set<string>` of optimistic selected IDs, and keep a `Set<string>` of pending channel IDs.
- [ ] Use the standard shadcn `Dialog` error pattern. Never use `window.alert`, `window.confirm`, or `window.prompt`.
- [ ] In Apollo’s mutation update, modify only the target channel in the normalized check:

```ts
cache.modify({
  id: cache.identify({ __typename: "CheckModel", id: checkId }),
  fields: {
    notificationChannelIds(existing: readonly string[] = []) {
      const withoutTarget = existing.filter((id) => id !== channel.id);
      return enabled ? [...withoutTarget, channel.id] : withoutTarget;
    },
  },
});
```

- [ ] Do not use a full-array Apollo optimistic response. Change local component state immediately, apply the target-only `cache.modify` after success, and on failure revert only the target channel in local state, call `client.refetchQueries({ include: [CHANNELS] })`, then set the dialog message to `Could not update notifications for ${checkName}. Please try again.` This prevents out-of-order responses from replacing another channel’s state and removes stale channel rows.
- [ ] Show `Notifications off` when enabled channels exist but the selected set is empty. Show `No active notification channels` with a `/channels` link when none exist.
- [ ] Run `npm test -- check-notification-channels.test.tsx`, `npm run lint`, and `npm run build`.
- [ ] Commit:

```bash
git add frontend/components/ui/switch.tsx frontend/components/app/check-notification-channels.tsx frontend/test/check-notification-channels.test.tsx frontend/lib/queries.ts frontend/package.json frontend/package-lock.json
git commit -m "feat(frontend): add check notification controls"
```

### Task 7: Add compact controls to dashboard cards

**Files:**

- Modify: `frontend/app/(app)/dashboard/page.tsx`
- Modify: `frontend/app/(app)/dashboard/page.test.tsx`
- Modify: `frontend/lib/queries.ts`

- [ ] Extend dashboard tests to prove the checks query requests `notificationChannelIds`, the channels query executes once for the active project, every card receives the same enabled-channel options, compact toggles remain independently interactive, and an all-off check displays `Notifications off`.
- [ ] Run `npm test -- app/'(app)'/dashboard/page.test.tsx` and confirm the new tests fail.
- [ ] Add `notificationChannelIds` to `CheckItem` and the `CHECKS` selection.
- [ ] Query `CHANNELS` once in `ChecksList` for the active project; pass sanitized enabled channel records to each `CheckNotificationChannels`.
- [ ] Render the compact control after the check status/probe metadata and before card actions without changing pause/resume behavior.
- [ ] Keep the existing 15-second checks polling. Do not poll channels per card.
- [ ] Run the dashboard test, `npm run lint`, and `npm run build`.
- [ ] Commit:

```bash
git add 'frontend/app/(app)/dashboard/page.tsx' 'frontend/app/(app)/dashboard/page.test.tsx' frontend/lib/queries.ts
git commit -m "feat(frontend): route dashboard notifications"
```

### Task 8: Add detail controls and remove acknowledgement

**Files:**

- Modify: `frontend/components/app/check-detail.tsx`
- Modify: `frontend/test/check-detail.test.tsx`
- Modify: `frontend/lib/queries.ts`

- [ ] Update detail tests to prove both ID and slug query shapes include `projectId` and `notificationChannelIds`, the project channels are loaded once, the detail control renders, and DOWN checks have no Acknowledge button.
- [ ] Add a regression test proving a recovery transition is displayed and routed without acknowledgement state.
- [ ] Run `npm test -- check-detail.test.tsx` and confirm the new assertions fail.
- [ ] Add `notificationChannelIds` to `CHECK` and `CHECK_BY_SLUG`.
- [ ] Query `CHANNELS` using `check.projectId`, then render the shared component with `variant="detail"`.
- [ ] Remove `ACKNOWLEDGE_CHECK`, the mutation hook, local acknowledging/error state, and the Acknowledge button from `CheckDetail`.
- [ ] Preserve pause/resume, status history, check metadata, and both detail routes.
- [ ] Run `npm test -- check-detail.test.tsx`, `npm run lint`, and `npm run build`.
- [ ] Commit:

```bash
git add frontend/components/app/check-detail.tsx frontend/test/check-detail.test.tsx frontend/lib/queries.ts
git commit -m "feat(frontend): simplify check alert actions"
```

### Task 9: Expose routing through MCP

**Files:**

- Modify: `integrations/mcp/src/tools.ts`
- Modify: `integrations/mcp/test/tools.test.ts`
- Modify: `integrations/mcp/README.md`
- Modify: `integrations/mcp/CLAUDE.md`

**Interface:**

```ts
{
  name: "set_check_channel_enabled",
  description: "Enable or disable one notification channel for a check.",
  inputSchema: z.object({
    checkId: z.string().min(1),
    channelId: z.string().min(1),
    enabled: z.boolean(),
  }),
}
```

- [ ] Add tool tests proving `get_check` returns `notificationChannelIds`, the new tool validates all three arguments, sends the exact GraphQL mutation, returns the updated effective IDs, and surfaces GraphQL authorization/errors consistently.
- [ ] Run `npm test -- tools.test.ts` from `integrations/mcp/` and confirm the new tests fail.
- [ ] Add `notificationChannelIds` to the existing `get_check` selection and rendered result.
- [ ] Add `set_check_channel_enabled` using the same GraphQL client/error wrapper as other write tools.
- [ ] Update the MCP tool table and remove obsolete wording that treats notification routing as unavailable.
- [ ] Document the new tool and required `checks:write` scope in the MCP `CLAUDE.md`.
- [ ] Run `npm test`, `npm run build`, and `npm run test:pack` from `integrations/mcp/`.
- [ ] Commit:

```bash
git add integrations/mcp
git commit -m "feat(mcp): manage check notification channels"
```

### Task 10: Remove escalation and acknowledgement from the API

**Files:**

- Delete: `api/src/escalation/escalation.model.ts`
- Delete: `api/src/escalation/escalation.module.ts`
- Delete: `api/src/escalation/escalation.resolver.ts`
- Delete: `api/src/escalation/escalation.service.ts`
- Modify: `api/src/app.module.ts`
- Modify: `api/src/tokens/token-policy.spec.ts`
- Modify: `api/test/escalation.e2e-spec.ts`
- Modify: `api/test/tokens.e2e-spec.ts`
- Modify: `api/src/schema.gql`
- Modify: `api/CLAUDE.md`

**Release boundary:** The Prisma `EscalationPolicy` and `Acknowledgement` models/tables stay in place and dormant until Release 3. Existing rows are not read or modified by product paths after this task.

- [ ] Replace escalation e2e coverage with schema assertions proving `escalationPolicies`, escalation policy mutations, and `acknowledgeCheck` are absent while `setCheckChannelEnabled` remains present.
- [ ] Remove acknowledgement token e2e cases and remove `acknowledgeCheck` from the token-policy denied-operation fixture.
- [ ] Run the targeted tests and confirm they fail while the old module is still registered.
- [ ] Remove both `EscalationModule` references from `AppModule` and delete the escalation GraphQL implementation.
- [ ] Regenerate `api/src/schema.gql` and verify none of these names remain:

```bash
grep -nE 'Escalation|escalation|acknowledgeCheck|Acknowledgement' api/src/schema.gql && exit 1 || true
```

- [ ] Update `api/CLAUDE.md` to describe DOWN/recovery routing and remove escalation/acknowledgement operations.
- [ ] Run `npm run lint`, `npm test`, `npm run test:e2e`, and `npm run build` from `api/`.
- [ ] Commit:

```bash
git add -A api/src/escalation api/src/app.module.ts api/src/tokens api/test api/src/schema.gql api/CLAUDE.md
git commit -m "refactor(api): retire escalation operations"
```

### Task 11: Stop scheduling and consuming escalation jobs

**Files:**

- Modify: `worker/src/alert-handler.ts`
- Delete: `worker/src/escalation.ts`
- Modify: `worker/src/notifiers.ts`
- Modify: `worker/cli/worker.ts`
- Modify: `worker/test/alert-handler.test.ts`
- Delete: `worker/test/escalation.test.ts`
- Modify: `worker/test/notifiers.test.ts`
- Create: `worker/test/worker-wiring.test.ts`
- Modify: `worker/CLAUDE.md`

**Release boundary:** Keep `queueEscalation` in `worker/src/config.ts`, `QUEUE_ESCALATION` in `worker/.env.example`, and Dokploy environment provisioning until Release 3. Release 2 simply has no producer or consumer.

- [ ] Change alert-handler tests to assert DOWN dispatch does not enqueue escalation work and recovery still uses the same selected channels.
- [ ] Change notifier tests to construct `NotifierDeps` without `enqueueEscalation`.
- [ ] Add `worker-wiring.test.ts` that reads `worker/cli/worker.ts` and asserts the runtime contains no `queueEscalation`, `scheduleEscalation`, or escalation worker construction while still containing alert, probe, and invite queue wiring.
- [ ] Run the targeted worker tests and confirm they fail against the old wiring.
- [ ] Remove `scheduleEscalation` from the DOWN transition, remove `enqueueEscalation` from `NotifierDeps`, delete the escalation processor, and remove escalation queue/worker construction and shutdown registration from the CLI.
- [ ] Do not change alert, probe, invite, watchdog, or graceful-drain behavior.
- [ ] Update `worker/CLAUDE.md` to define exactly two notification events: DOWN and recovery.
- [ ] Run `npm test` and `npx tsc -p tsconfig.build.json --noEmit` from `worker/`.
- [ ] Commit:

```bash
git add -A worker/src/alert-handler.ts worker/src/escalation.ts worker/src/notifiers.ts worker/cli/worker.ts worker/test worker/CLAUDE.md
git commit -m "refactor(worker): retire escalation jobs"
```

### Task 12: Remove escalation UI and update public product language

**Files:**

- Delete: `frontend/app/(app)/escalation/page.tsx`
- Delete: `frontend/lib/escalation.ts`
- Delete: `frontend/test/escalation-steps.test.ts`
- Modify: `frontend/components/app/sidebar.tsx`
- Delete: `frontend/components/marketing/escalation.tsx`
- Create: `frontend/components/marketing/notification-routing.tsx`
- Modify: `frontend/app/(marketing)/page.tsx`
- Modify: `frontend/components/marketing/feature-grid.tsx`
- Modify: `frontend/components/marketing/how-it-works.tsx`
- Modify: `frontend/components/marketing/mcp.tsx`
- Modify: `frontend/lib/site.ts`
- Modify: `frontend/CLAUDE.md`
- Create: `frontend/test/notification-routing-marketing.test.tsx`

- [ ] Add tests proving the sidebar has no Escalation destination, the marketing page renders per-check notification routing, product copy mentions DOWN and recovery, and no escalation-policy/acknowledgement claims remain.
- [ ] Run the new marketing test and relevant frontend suite; confirm failures against the old copy/navigation.
- [ ] Remove the escalation route, query helpers, step editor, tests, and sidebar item.
- [ ] Replace the marketing escalation timeline with `NotificationRouting`, showing a check with selected Email, Telegram, and Webhook rows plus concise DOWN/recovery copy.
- [ ] Update feature grid, how-it-works, MCP copy, site metadata, and frontend docs to describe per-check channels truthfully.
- [ ] Keep the existing visual system, shadcn primitives, lucide icons, accessibility, and responsive behavior.
- [ ] Run this guard and inspect every remaining hit:

```bash
grep -RInE 'escalat|acknowledg' frontend \
  --exclude-dir=node_modules --exclude-dir=.next
```

- [ ] Run `npm run lint`, `npm test`, and `npm run build` from `frontend/`.
- [ ] Commit:

```bash
git add -A frontend
git commit -m "refactor(frontend): replace escalation with routing"
```

### Task 13: Update repository documentation for the product cutover

**Files:**

- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify only if present and relevant: public examples under `docs/`

- [ ] Update the feature overview to say checks notify selected enabled project channels on DOWN and recovery transitions.
- [ ] Document the exclusion table, `notificationChannelIds`, `setCheckChannelEnabled`, worker filtering, default-all behavior, all-off behavior, and move reset.
- [ ] State that acknowledgement and escalation APIs/UI/jobs were removed in Release 2 while dormant tables and the unused queue environment value remain for one observation window.
- [ ] Document that no infrastructure Compose deployment is part of this release.
- [ ] Update public repository links to `https://github.com/SystemVitals/systemvitals` where the old owner is referenced.
- [ ] Run:

```bash
grep -RInE 'github.com/nihey/systemvitals|acknowledg|escalation polic' \
  README.md CLAUDE.md docs api/CLAUDE.md frontend/CLAUDE.md \
  worker/CLAUDE.md database/CLAUDE.md integrations/mcp
```

- [ ] Review every hit and retain only explicitly historical Release 2/Release 3 migration notes.
- [ ] Run `git diff --check`.
- [ ] Commit:

```bash
git add README.md CLAUDE.md docs
git commit -m "docs: explain check notification routing"
```

### Task 14: Validate and ship the product cutover

**Files:**

- Modify only if required by validation: files already owned by Tasks 6–13

- [ ] Run:

```bash
cd database && npm test && npm run generate && npx prisma validate
cd ../api && npm run lint && npm test && npm run test:e2e && npm run build
cd ../worker && npm test && npx tsc -p tsconfig.build.json --noEmit
cd ../frontend && npm run lint && npm test && npm run build
cd ../integrations/mcp && npm test && npm run build && npm run test:pack
cd ../.. && bash scripts/test/dokploy-provision.test.sh
git diff --check
```

- [ ] Search the whole tracked tree for removed product surfaces and inspect every remaining result:

```bash
git grep -nE 'acknowledgeCheck|EscalationModule|scheduleEscalation|enqueueEscalation'
```

Expected result: no matches.

- [ ] Verify `QUEUE_ESCALATION`, dormant Prisma models/tables, and their cleanup documentation are the only deliberate legacy artifacts.
- [ ] Verify no secret file or value is staged with `git status --short`, `git diff --cached --stat`, and a repository secret scanner.
- [ ] Manually exercise:
  - dashboard compact toggles;
  - ID and slug check detail toggles;
  - all-off state;
  - a failed toggle and dialog rollback;
  - one real DOWN then recovery through each supported channel type;
  - enabling a channel after check creation;
  - moving a check between projects;
  - MCP `get_check` and `set_check_channel_enabled`.
- [ ] Push, open the protected Release 2 pull request, and wait for all required checks.
- [ ] Merge after checks pass. Confirm Dokploy deploy order is API, frontend, then worker.
- [ ] Run `bash scripts/smoke-zero-downtime.sh --duration 900 --interval 1 --output /tmp/systemvitals-release2-smoke.jsonl` throughout rollout and confirm the summary reports zero failures.
- [ ] Confirm the infrastructure Compose application was not deployed or restarted.
- [ ] Observe at least one normal alert/recovery cycle and confirm the escalation queue receives no new jobs.

---

## Release 3 — Remove Dormant Legacy Schema and Configuration

### Task 15: Drop escalation and acknowledgement persistence

**Files:**

- Modify: `database/prisma/schema.prisma`
- Create: `database/prisma/migrations/20260730120000_remove_escalation_acknowledgements/migration.sql`
- Create: `database/test/remove-escalation-acknowledgements-migration.test.ts`
- Modify: `database/CLAUDE.md`
- Modify: `api/test/move-check.e2e-spec.ts`

**Precondition:** Production has completed the Release 2 observation window, no rollback to Release 1 code is required, and a current database backup has been verified.

- [ ] Add a failing migration test proving the migration drops `acknowledgements` before `escalation_policies`, does not touch `check_channel_exclusions`, and contains no data-copy statement.
- [ ] Remove `Acknowledgement`, `EscalationPolicy`, and their inverse relations from `User`, `Check`, and `Project`.
- [ ] Add explicit SQL:

```sql
BEGIN;
DROP TABLE IF EXISTS "acknowledgements";
DROP TABLE IF EXISTS "escalation_policies";
COMMIT;
```

- [ ] Remove dormant acknowledgement fixture/assertion paths from move-check e2e coverage while retaining exclusion-reset assertions.
- [ ] Update database docs to describe only the active routing schema.
- [ ] Run `npm run generate`, `npx prisma validate`, and `npm test` from `database/`, then the move-check e2e test from `api/`.
- [ ] Commit:

```bash
git add database api/test/move-check.e2e-spec.ts
git commit -m "refactor(database): remove escalation persistence"
```

### Task 16: Remove escalation queue configuration from runtime and Dokploy provisioning

**Files:**

- Modify: `worker/src/config.ts`
- Modify: `worker/.env.example`
- Create: `worker/test/config.test.ts`
- Modify: `scripts/provision-dokploy-zero-downtime.sh`
- Modify: `scripts/test/dokploy-provision.test.sh`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `worker/CLAUDE.md`

- [ ] Add or update tests proving worker config has no `queueEscalation` key and the Dokploy worker env allowlist/fixture omits `QUEUE_ESCALATION`.
- [ ] Run the targeted worker config and provisioning tests; confirm failures while the legacy setting remains.
- [ ] Remove `queueEscalation` and `QUEUE_ESCALATION` from worker defaults/examples.
- [ ] Remove `QUEUE_ESCALATION` from the worker environment key list in the zero-downtime provisioner and its exact test fixture.
- [ ] Do not modify queue names or environment handling for alert, probe, invite, Redis, readiness, scheduler leases, or graceful shutdown.
- [ ] Update deployment and worker docs to remove the observation-window note.
- [ ] Run:

```bash
cd worker && npm test && npx tsc -p tsconfig.build.json --noEmit
cd .. && bash scripts/test/dokploy-provision.test.sh
git grep -n 'QUEUE_ESCALATION'
```

Expected result: no matches.

- [ ] Commit:

```bash
git add worker scripts/provision-dokploy-zero-downtime.sh scripts/test/dokploy-provision.test.sh docs/DEPLOYMENT.md
git commit -m "refactor(deploy): remove escalation queue config"
```

### Task 17: Final regression, security, and zero-downtime release

**Files:**

- Modify only if required by validation: files already owned by Tasks 15–16

- [ ] Run every repository suite:

```bash
cd database && npm test && npm run generate && npx prisma validate
cd ../api && npm run lint && npm test && npm run test:e2e && npm run build
cd ../worker && npm test && npx tsc -p tsconfig.build.json --noEmit
cd ../frontend && npm run lint && npm test && npm run build
cd ../integrations/mcp && npm test && npm run build && npm run test:pack
cd ../.. && bash scripts/test/dokploy-provision.test.sh
git diff --check
```

- [ ] Run:

```bash
git grep -nE 'Acknowledgement|acknowledgement|acknowledgeCheck|EscalationPolicy|QUEUE_ESCALATION|scheduleEscalation|enqueueEscalation'
```

Expected result: no active code, schema, configuration, or product documentation matches. Migration filenames and the approved design/implementation documents may retain historical terms.

- [ ] Review the final Prisma migration plan against a fresh database and a production-shaped backup clone before applying it to production.
- [ ] Verify the public diff contains no secret values, `.env` files, private URLs, tokens, keys, local databases, or generated build artifacts.
- [ ] Push, open the protected Release 3 pull request, and wait for all required checks.
- [ ] Before merge, verify the production database backup and document the rollback boundary: application rollback may require restoring the pre-Release-3 database because the dropped legacy data is intentionally unrecoverable from schema migration alone.
- [ ] Merge after checks pass. Confirm Dokploy deploys API, frontend, then worker and does not deploy infrastructure Compose.
- [ ] Run `bash scripts/smoke-zero-downtime.sh --duration 900 --interval 1 --output /tmp/systemvitals-release3-smoke.jsonl` throughout rollout and confirm the summary reports zero failures.
- [ ] Verify a post-cleanup DOWN and recovery event reaches exactly the selected channels and all-off reaches none.
- [ ] Confirm no escalation queue, acknowledgement record, or escalation-policy table remains in active production operation.

## Completion Criteria

- Every enabled project channel is selected for a check unless an exclusion exists.
- Dashboard and check detail toggles save immediately, have per-channel loading and rollback, show channel-type icons, and allow a clear all-off state.
- DOWN and recovery are the only notification events.
- No acknowledgement or escalation product/API/worker surface remains.
- GraphQL and MCP expose the same project-scoped routing capability.
- All tests and protected checks pass for each release.
- API/frontend/worker continue automatic zero-downtime Dokploy deployment after merge.
- Infrastructure Compose is never auto-deployed by these releases.
- No sensitive information is introduced into the public repository or its history.
