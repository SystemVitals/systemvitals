# Organization Workspace Flattening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each organization the only public workspace while retaining exactly one internal project per organization and one release of project-ID compatibility.

**Architecture:** Enforce a unique `projects.organization_id`, keep `Project` as an internal relational workspace, and add one NestJS workspace resolver that converts a canonical `organizationId` or deprecated `projectId` into the same authorized internal project. Migrate the frontend and MCP integration to organization-first contracts while retaining legacy GraphQL arguments, response fields, MCP parameters, and authenticated route redirects for one compatibility release. Deploy through the existing API → frontend → worker Dokploy sequence without changing worker payloads or stateful infrastructure.

**Tech Stack:** PostgreSQL 18 + Prisma 6, NestJS 11 code-first GraphQL, Next.js 16 App Router + React 19 + TypeScript + Apollo Client 4 + Tailwind CSS v4 + shadcn/ui, BullMQ + Redis worker, MCP SDK + Zod, Jest/Vitest, npm on Node.js 22, GitHub Actions, Dokploy.

## Global Constraints

- Every organization has exactly one internal `Project`; users never create, select, rename, or see projects in the canonical product.
- `projects.organization_id` is unique. Organization/signup creation creates the `Default` internal project in the same transaction.
- The migration is lossless. A read-only preflight and the migration itself report and reject organizations with zero or multiple projects; neither path creates, selects, merges, moves, or deletes user data.
- `organizationId` is canonical. Existing `projectId` GraphQL arguments and fields remain deprecated but functional for exactly this compatibility release.
- Compatibility operations accept exactly one of `organizationId` or `projectId`; both and neither return the same stable validation error.
- `createProject` and the MCP `create_project` tool are removed immediately because they contradict the database invariant.
- Existing project-scoped API tokens remain valid. New scoped-token creation uses `organizationId` and stores the resolved internal `projectId`.
- Canonical check URLs are `/{organization}/{check}`. The old `/{organization}/{project}/{check}` route validates the complete legacy tuple before permanently redirecting.
- Public status-page URLs and worker queue/job payloads do not change.
- Use GraphQL for application data; add no REST data endpoint.
- Preserve ownership, scoped-token capability checks, creator locks, quota checks, and non-disclosing cross-organization failures.
- Use test-driven development: add a failing focused test, run it red, implement the smallest change, rerun it green, then run the affected suite.
- Update only public `AGENTS.md`, `README.md`, `docs/`, generated GraphQL schema, and MCP documentation. Do not edit private `CLAUDE.md` files.
- Keep `../nihey/.env` external and untracked. Never print, copy, stage, or commit its values.
- Do not modify or deploy `docker-compose.infrastructure.yml`. Keep automatic Dokploy application rollout ordered API → frontend → worker.
- Use the repository's existing npm projects; do not introduce a root workspace or another package manager.

---

### Task 1: Enforce the one-workspace invariant and remove project creation

**Files:**

- Modify: `database/prisma/schema.prisma`
- Create: `database/prisma/migrations/20260731120000_enforce_one_project_per_organization/migration.sql`
- Create: `database/src/organization-workspace-preflight.ts`
- Modify: `database/src/index.ts`
- Create: `database/scripts/preflight-organization-workspaces.ts`
- Modify: `database/package.json`
- Create: `database/test/organization-workspace-preflight.test.ts`
- Create: `database/test/organization-workspace-migration.test.ts`
- Modify: `api/src/projects/projects.service.ts`
- Modify: `api/src/projects/projects.resolver.ts`
- Modify: `api/src/auth/auth.service.spec.ts`
- Modify: `api/src/organizations/organizations.service.spec.ts`
- Modify: `api/test/projects.e2e-spec.ts`
- Modify: `api/test/move-check.e2e-spec.ts`
- Modify: `api/test/tokens.e2e-spec.ts`
- Modify: `api/test/check-notification-channels.e2e-spec.ts`
- Modify: `api/test/check-expected-project-aba-concurrency.e2e-spec.ts`
- Modify: `api/test/slug-backfill.e2e-spec.ts`
- Modify: `integrations/mcp/src/tools.ts`
- Modify: `integrations/mcp/test/tools.test.ts`
- Modify: `integrations/mcp/test/credential.test.ts`
- Modify: `integrations/mcp/test/server.test.ts`
- Modify: `api/src/schema.gql`

**Interfaces:**

```ts
export interface OrganizationWorkspaceCount {
  organizationId: string;
  projectCount: number;
}

export function incompatibleOrganizationWorkspaces(
  rows: readonly OrganizationWorkspaceCount[],
): OrganizationWorkspaceCount[];

export async function inspectOrganizationWorkspaces(
  prisma: PrismaClient,
): Promise<OrganizationWorkspaceCount[]>;
```

```json
{
  "scripts": {
    "preflight:organization-workspaces": "tsx scripts/preflight-organization-workspaces.ts"
  }
}
```

- [ ] **Step 1: Write failing preflight and migration-contract tests.**

```ts
it("reports zero-project and multi-project organizations in stable ID order", () => {
  expect(
    incompatibleOrganizationWorkspaces([
      { organizationId: "org-ok", projectCount: 1 },
      { organizationId: "org-many", projectCount: 3 },
      { organizationId: "org-empty", projectCount: 0 },
    ]),
  ).toEqual([
    { organizationId: "org-empty", projectCount: 0 },
    { organizationId: "org-many", projectCount: 3 },
  ]);
});

it("guards before creating the unique organization index without data writes", () => {
  expect(sql).toMatch(/HAVING COUNT\(p\.id\) <> 1/i);
  expect(sql).toMatch(/RAISE EXCEPTION/i);
  expect(sql).toContain('CREATE UNIQUE INDEX "projects_organization_id_key"');
  expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COPY)\b/i);
});
```

- [ ] **Step 2: Run the new database tests and verify RED.**

Run from `database/`:

```bash
npm test -- organization-workspace-preflight.test.ts organization-workspace-migration.test.ts
```

Expected: fail because the preflight module and migration do not exist.

- [ ] **Step 3: Implement the read-only preflight and guarded migration.**

Use the same query in the library and SQL guard:

```sql
SELECT o.id AS "organizationId", COUNT(p.id)::int AS "projectCount"
FROM organizations o
LEFT JOIN projects p ON p.organization_id = o.id
GROUP BY o.id
HAVING COUNT(p.id) <> 1
ORDER BY o.id;
```

The CLI prints a success count or the incompatible ID/count JSON, sets a
non-zero exit code when rows exist, disconnects Prisma in `finally`, and never
prints `DATABASE_URL`. The migration wraps the guard and unique-index creation
in `BEGIN`/`COMMIT`, locks `organizations` and `projects` before repeating the
cardinality query, and holds those locks through index creation so concurrent
organization/project writes cannot race the validation. Its `DO $$` block
aggregates the incompatible IDs/counts into the exception before any DDL runs.
Add `@unique` to
`Project.organizationId` and retain the existing
`@@unique([organizationId, slug])` for the legacy route lookup.

- [ ] **Step 4: Run database generation, validation, and focused tests.**

Use the repository's temporary-PostgreSQL test conventions to prove:
one-project data succeeds; zero/multiple project data reports every ID/count; a
rejected migration leaves rows and indexes unchanged; a successful migration
rejects a second project; organization deletion still cascades.

```bash
npm run generate
npx prisma validate
npm test -- organization-workspace-preflight.test.ts organization-workspace-migration.test.ts
```

Expected: all pass.

- [ ] **Step 5: Write failing API and MCP tests proving project creation is absent.**

Update `projects.e2e-spec.ts` to assert GraphQL validation rejects
`createProject`, and update MCP catalogs to assert `create_project` is absent.
Keep the deprecated `projects` query covered. Add transaction assertions to
the auth and organization service specs proving the organization, membership,
and `Default` project use the same transaction and a rejected project create
rejects the whole operation.

- [ ] **Step 6: Remove project creation code and convert impossible fixtures.**

Delete `ProjectsService.create`, `ProjectsResolver.createProject`,
`CreateProjectResponse`, and the MCP `create_project` tool. Preserve project
listing and ping-key compatibility.

Convert each same-organization multi-project test fixture into the invariant it
now represents:

- token and notification isolation use a second organization with its own
  project;
- move tests use distinct source/destination organizations and reject a
  same-organization destination by organization ID in Task 3;
- expected-project ABA tests move across two organizations while retaining the
  same stale-project comparison;
- slug-backfill tests use separate organizations where the post-migration
  schema no longer permits two projects in one organization.

Run this audit and inspect every remaining hit; each organization fixture may
create only one project:

```bash
grep -RIn "project\\.create\\|project\\.createMany" \
  api/test database/test worker/test
```

- [ ] **Step 7: Regenerate the schema and run invariant suites.**

```bash
cd ../api
npm test -- auth.service.spec.ts organizations.service.spec.ts
npm run test:e2e -- projects.e2e-spec.ts move-check.e2e-spec.ts tokens.e2e-spec.ts check-notification-channels.e2e-spec.ts check-expected-project-aba-concurrency.e2e-spec.ts slug-backfill.e2e-spec.ts
cd ../integrations/mcp
npm test -- tools.test.ts credential.test.ts server.test.ts
```

Expected: all pass; `api/src/schema.gql` contains no `createProject`.

- [ ] **Step 8: Commit the invariant foundation.**

```bash
git add database api/src/projects api/src/auth/auth.service.spec.ts \
  api/src/organizations/organizations.service.spec.ts api/test \
  api/src/schema.gql integrations/mcp/src/tools.ts integrations/mcp/test
git commit -m "feat: enforce one workspace per organization"
```

---

### Task 2: Add the shared API workspace facade and canonical organization metadata

**Files:**

- Create: `api/src/workspaces/workspace-selector.ts`
- Create: `api/src/workspaces/workspace-selector.spec.ts`
- Create: `api/src/workspaces/workspaces.service.ts`
- Create: `api/src/workspaces/workspaces.service.spec.ts`
- Create: `api/src/workspaces/workspaces.module.ts`
- Modify: `api/src/app.module.ts`
- Modify: `api/src/common/models.ts`
- Modify: `api/src/organizations/organizations.resolver.ts`
- Modify: `api/src/organizations/organizations.service.ts`
- Modify: `api/src/organizations/organizations.service.spec.ts`
- Modify: `api/src/projects/projects.resolver.ts`
- Modify: `api/src/projects/projects.service.ts`
- Create: `api/src/projects/projects.resolver.spec.ts`
- Modify: `api/src/schema.gql`

**Interfaces:**

```ts
export interface WorkspaceSelector {
  organizationId?: string | null;
  projectId?: string | null;
}

export interface ResolvedWorkspace {
  organizationId: string;
  projectId: string;
}

export function assertWorkspaceSelector(
  selector: WorkspaceSelector,
): { organizationId: string } | { projectId: string };

@Injectable()
export class WorkspacesService {
  resolveForUser(
    userId: string,
    selector: WorkspaceSelector,
  ): Promise<ResolvedWorkspace>;
  resolveOrganizationForProject(projectId: string): Promise<string>;
}
```

Stable XOR error:

```text
Provide exactly one of organizationId or projectId
```

- [ ] **Step 1: Write failing selector and service tests.**

Cover organization success, legacy project success, both/neither validation,
inaccessible organization/project non-disclosure, zero projects, and two
projects returned by a mocked pre-constraint client.

```ts
expect(() =>
  assertWorkspaceSelector({ organizationId: "org-1", projectId: "project-1" }),
).toThrow("Provide exactly one of organizationId or projectId");
```

- [ ] **Step 2: Run the workspace tests and verify RED.**

```bash
cd api
npm test -- workspace-selector.spec.ts workspaces.service.spec.ts
```

- [ ] **Step 3: Implement the facade and module.**

`resolveForUser` folds membership into each lookup, requests at most two
projects for organization resolution, returns the sole internal project, and
throws a generic not-found/forbidden response for inaccessible scopes. A
visible organization with a project count other than one throws
`InternalServerErrorException("Organization workspace is inconsistent")`.
Register `WorkspacesModule` as a global module in `AppModule`.

- [ ] **Step 4: Add canonical organization presentation fields with deprecated compatibility fields.**

`OrganizationModel` gains `pingKey`; its `projects` field remains for the
compatibility release with `deprecationReason: "Organizations now contain one implicit workspace."`.
`ProjectModel` remains deprecated compatibility output. `me` and organization
mutations map the sole project's ping key onto the organization while retaining
the one-element `projects` collection.

Add a canonical mutation:

```graphql
regenerateOrganizationPingKey(organizationId: ID!): OrganizationModel!
```

Keep `regeneratePingKey(projectId: ID!)` deprecated for one release. Both
mutations authorize membership and call the same internal rotation method.

- [ ] **Step 5: Run focused tests, regenerate the schema, and verify deprecations.**

```bash
npm test -- workspace-selector.spec.ts workspaces.service.spec.ts projects.resolver.spec.ts organizations.service.spec.ts
npm run build
grep -n "regenerateOrganizationPingKey\\|projects.*deprecated" src/schema.gql
```

- [ ] **Step 6: Commit the workspace facade.**

```bash
git add api/src/workspaces api/src/app.module.ts api/src/common/models.ts \
  api/src/organizations api/src/projects api/src/schema.gql
git commit -m "feat(api): add organization workspace facade"
```

---

### Task 3: Migrate checks, canonical check lookup, and moves to organizations

**Files:**

- Modify: `api/src/checks/check.model.ts`
- Modify: `api/src/checks/checks.resolver.ts`
- Modify: `api/src/checks/checks.service.ts`
- Modify: `api/src/checks/checks.resolver.spec.ts`
- Modify: `api/src/checks/checks.service.spec.ts`
- Modify: `api/src/checks/check-update.spec.ts`
- Modify: `api/src/checks/checks.module.ts`
- Modify: `api/src/tokens/token-policy.ts`
- Modify: `api/src/tokens/token-policy.spec.ts`
- Create: `api/test/organization-workspace-checks.e2e-spec.ts`
- Modify: `api/test/move-check.e2e-spec.ts`
- Modify: `api/test/slug-resolution.e2e-spec.ts`
- Modify: `api/src/schema.gql`

**Interfaces:**

```graphql
checks(organizationId: ID, projectId: ID @deprecated(reason: "Use organizationId.")): [CheckModel!]!
createCheck(
  graceSeconds: Int!
  name: String!
  organizationId: ID
  periodSeconds: Int
  projectId: ID @deprecated(reason: "Use organizationId.")
  schedule: String
  tz: String
): CheckModel!
createActiveCheck(
  expectedStatus: Int
  intervalSeconds: Int!
  method: String
  name: String!
  organizationId: ID
  projectId: ID @deprecated(reason: "Use organizationId.")
  target: String!
  timeoutMs: Int!
  type: String!
): CheckModel!
checkByOrganizationSlug(orgSlug: String!, checkSlug: String!): CheckModel!
moveCheck(
  checkId: ID!
  destinationOrganizationId: ID
  destinationProjectId: ID @deprecated(reason: "Use destinationOrganizationId.")
): CheckModel!
```

`CheckModel` gains canonical `organizationId: ID!`; `projectId` remains
deprecated for this release.

- [ ] **Step 1: Add failing resolver tests for dual scope and canonical moves.**

For `checks`, `createCheck`, and `createActiveCheck`, assert organization
resolution occurs before `requireCheckAccess`; legacy project IDs still work;
both/neither fail with the stable XOR error. For moves, assert exactly one
destination identifier, an organization resolves to its workspace, and the
existing service receives the resolved project ID.

- [ ] **Step 2: Add failing service tests for organization-only slug lookup.**

```ts
await service.findByOrganizationSlug(
  "user-1",
  "acme",
  "nightly-backup",
);
```

Assert the query folds `memberships: { some: { userId } }` into the project
organization predicate and returns not found for both inaccessible and missing
checks. Keep the existing triple-slug lookup unchanged for legacy redirects.

- [ ] **Step 3: Run focused tests and verify RED.**

```bash
npm test -- checks.resolver.spec.ts checks.service.spec.ts token-policy.spec.ts
```

- [ ] **Step 4: Implement organization-scoped check operations.**

Inject `WorkspacesService`, add nullable GraphQL args with deprecation reasons,
resolve one selector, run existing token capability checks against the resolved
internal project ID, and pass that ID to current services. Attach the resolved
`organizationId` to list/create results. For resource-ID mutations, map the
current project back to its organization before returning so every
`CheckModel` path can resolve `organizationId` without per-row N+1 queries.

Implement `checkByOrganizationSlug` as a single membership-folded Prisma query.
Do not split existence and membership into separate queries.

- [ ] **Step 5: Implement organization-only moves without weakening concurrency guards.**

The resolver converts `destinationOrganizationId` to the sole destination
project, then calls the existing creator-stable `ChecksService.move`. Update
messages from “destination project” to “destination organization” only where
they are public; keep internal `destinationProjectId` variable names inside
the locked transaction. Preserve quota locking, status-page cleanup,
notification-exclusion cleanup, slug collision checks, and P2002 translation.

- [ ] **Step 6: Add GraphQL e2e compatibility coverage.**

The new e2e file proves:

- canonical and legacy list/create return the same resources;
- canonical responses include `organizationId`;
- deprecated responses still include `projectId`;
- both/neither scope is rejected;
- project-scoped tokens remain confined to their resolved workspace;
- canonical slug lookup is non-disclosing;
- destination organization moves succeed and same-organization moves fail;
- old `destinationProjectId` moves still work for this release.

- [ ] **Step 7: Run check suites and regenerate the schema.**

```bash
npm test -- checks.resolver.spec.ts checks.service.spec.ts check-update.spec.ts token-policy.spec.ts
npm run test:e2e -- organization-workspace-checks.e2e-spec.ts move-check.e2e-spec.ts slug-resolution.e2e-spec.ts
npm run build
```

- [ ] **Step 8: Commit organization-first checks.**

```bash
git add api/src/checks api/src/tokens/token-policy.ts \
  api/src/tokens/token-policy.spec.ts api/test/organization-workspace-checks.e2e-spec.ts \
  api/test/move-check.e2e-spec.ts api/test/slug-resolution.e2e-spec.ts api/src/schema.gql
git commit -m "feat(api): scope checks to organizations"
```

---

### Task 4: Migrate channels, status pages, Telegram, verification, and ping keys

**Files:**

- Modify: `api/src/channels/channel.model.ts`
- Modify: `api/src/channels/channels.resolver.ts`
- Modify: `api/src/channels/channels.service.ts`
- Modify: `api/src/channels/channels.service.spec.ts`
- Modify: `api/src/channels/channels.module.ts`
- Modify: `api/src/channels/email-verification.model.ts`
- Modify: `api/src/channels/email-verification.service.ts`
- Modify: `api/src/channels/email-verification.service.spec.ts`
- Modify: `api/src/status-pages/status-page.model.ts`
- Modify: `api/src/status-pages/status-pages.resolver.ts`
- Modify: `api/src/status-pages/status-pages.service.ts`
- Modify: `api/src/status-pages/status-pages.service.spec.ts`
- Modify: `api/src/status-pages/status-pages.module.ts`
- Modify: `api/src/telegram/telegram.resolver.ts`
- Modify: `api/src/telegram/telegram-connections.service.ts`
- Modify: `api/src/telegram/telegram-connections.service.spec.ts`
- Modify: `api/src/telegram/telegram.module.ts`
- Modify: `api/test/channels.e2e-spec.ts`
- Modify: `api/test/status-pages.e2e-spec.ts`
- Modify: `api/test/telegram.e2e-spec.ts`
- Modify: `api/test/email-channel-verification.e2e-spec.ts`
- Modify: `api/test/projects.e2e-spec.ts`
- Modify: `api/src/schema.gql`

**Interfaces:**

```graphql
channels(organizationId: ID, projectId: ID @deprecated(reason: "Use organizationId.")): [ChannelModel!]!
createChannel(
  configJson: String!
  organizationId: ID
  projectId: ID @deprecated(reason: "Use organizationId.")
  type: String!
): ChannelModel!
statusPages(organizationId: ID, projectId: ID @deprecated(reason: "Use organizationId.")): [StatusPageModel!]!
createStatusPage(
  brandingJson: String
  checkIds: [ID!]!
  organizationId: ID
  projectId: ID @deprecated(reason: "Use organizationId.")
  slug: String!
  title: String!
): StatusPageModel!
connectTelegramChannel(token: String!, organizationId: ID, projectId: ID @deprecated(reason: "Use organizationId.")): ChannelModel!
```

`ChannelModel` and `StatusPageModel` gain `organizationId: ID!` and retain
deprecated `projectId`. Email verification preview/confirmation gain canonical
`organizationName`; deprecated `projectName` remains for one release.

- [ ] **Step 1: Write failing resolver/service tests for each organization scope.**

For each list/create/connect path, prove canonical organization resolution,
legacy project compatibility, both/neither rejection, cross-organization
non-disclosure, and canonical `organizationId` output. Add verification tests
proving the public copy can use `organizationName` without exposing `Default`.

- [ ] **Step 2: Run focused tests and verify RED.**

```bash
npm test -- channels.service.spec.ts email-verification.service.spec.ts status-pages.service.spec.ts telegram-connections.service.spec.ts projects.resolver.spec.ts
```

- [ ] **Step 3: Implement the shared resolution at resolver boundaries.**

Inject `WorkspacesService` into the affected modules/resolvers. Resolve exactly
one selector, then call the unchanged internal services with `projectId`.
Attach `organizationId` to returned resources in batched list/create paths.
Resource-ID update/delete/resend operations continue deriving ownership from
the resource itself.

For email verification, select the organization name through
`channel.project.organization.name`, return it as `organizationName`, and
retain the project-name field only as deprecated compatibility output.

- [ ] **Step 4: Preserve security-sensitive behavior.**

Do not change email token hashing/expiry, Telegram challenge single-use
transactions, sanitized channel config, status-page check ownership
validation, public status-page routes, or ping-key entropy. Canonical and
legacy ping-key mutations must rotate the same internal project row.

- [ ] **Step 5: Add and run e2e compatibility cases.**

```bash
npm run test:e2e -- channels.e2e-spec.ts status-pages.e2e-spec.ts telegram.e2e-spec.ts email-channel-verification.e2e-spec.ts projects.e2e-spec.ts
npm run build
```

Assert `Default` is absent from canonical verification responses and
organization-first operations; assert legacy project calls still succeed.

- [ ] **Step 6: Commit remaining organization-scoped API resources.**

```bash
git add api/src/channels api/src/status-pages api/src/telegram api/src/projects \
  api/test/channels.e2e-spec.ts api/test/status-pages.e2e-spec.ts \
  api/test/telegram.e2e-spec.ts api/test/email-channel-verification.e2e-spec.ts \
  api/test/projects.e2e-spec.ts api/src/schema.gql
git commit -m "feat(api): scope workspace resources to organizations"
```

---

### Task 5: Add organization-scoped tokens while preserving existing credentials

**Files:**

- Modify: `api/src/tokens/create-api-token.input.ts`
- Modify: `api/src/tokens/token.model.ts`
- Modify: `api/src/tokens/tokens.resolver.ts`
- Modify: `api/src/tokens/tokens.service.ts`
- Modify: `api/src/tokens/tokens-core.module.ts`
- Create: `api/src/tokens/tokens.resolver.spec.ts`
- Create: `api/src/tokens/tokens.service.spec.ts`
- Modify: `api/src/tokens/api-token.strategy.spec.ts`
- Modify: `api/test/tokens.e2e-spec.ts`
- Modify: `api/test/token-schema-isolation.e2e-spec.ts`
- Modify: `api/src/schema.gql`

**Interfaces:**

```graphql
input CreateApiTokenInput {
  name: String!
  capabilities: [String!]!
  organizationId: ID
  projectId: ID @deprecated(reason: "Use organizationId.")
  expirationDays: Int
}

type ApiTokenModel {
  organizationId: ID
  projectId: ID @deprecated(reason: "Use organizationId.")
}

type ApiCredential {
  organizationId: ID
  organizationName: String
  projectId: ID @deprecated(reason: "Use organizationId.")
  projectName: String @deprecated(reason: "Use organizationName.")
}
```

- [ ] **Step 1: Write failing token unit tests.**

Assert organization-scoped creation resolves the internal project and stores
that ID, project-scoped creation still works, both/neither input fails,
existing stored project-scoped tokens authenticate unchanged, token lists
derive `organizationId`, and deleted-project history remains readable through
existing snapshots without inventing an organization ID.

- [ ] **Step 2: Run focused token tests and verify RED.**

```bash
npm test -- tokens.resolver.spec.ts tokens.service.spec.ts api-token.strategy.spec.ts
```

- [ ] **Step 3: Implement canonical token input/output.**

Make both scope fields optional at GraphQL/class-validation level and apply the
same `assertWorkspaceSelector` XOR in `TokensService.createScoped`. New
organization calls resolve and store `project.id`; legacy calls retain current
behavior. Include `project.organizationId` and organization name in list/create
selects and credential lookup.

Keep the compatibility `credentialMode` string `PROJECT_SCOPED` for this
release so existing MCP clients do not break; canonical identity comes from
the new organization fields.

- [ ] **Step 4: Add e2e coverage and schema isolation assertions.**

```bash
npm run test:e2e -- tokens.e2e-spec.ts token-schema-isolation.e2e-spec.ts
npm run build
```

Prove JWT and API-token GraphQL schemas expose only their intended fields,
existing plaintext/token redaction remains intact, and cross-organization
capabilities fail closed.

- [ ] **Step 5: Commit organization-scoped credentials.**

```bash
git add api/src/tokens api/test/tokens.e2e-spec.ts \
  api/test/token-schema-isolation.e2e-spec.ts api/src/schema.gql
git commit -m "feat(api): issue organization-scoped credentials"
```

---

### Task 6: Switch frontend workspace state and primary pages to organizations

**Files:**

- Modify: `frontend/lib/auth-context.tsx`
- Modify: `frontend/test/auth-context.test.tsx`
- Modify: `frontend/lib/org-context.tsx`
- Modify: `frontend/lib/org-context.test.tsx`
- Modify: `frontend/lib/queries.ts`
- Create: `frontend/lib/legacy-queries.ts`
- Modify: `frontend/lib/graphql-documents.test.ts`
- Modify: `frontend/app/(app)/dashboard/page.tsx`
- Modify: `frontend/app/(app)/dashboard/page.test.tsx`
- Modify: `frontend/app/(app)/channels/page.tsx`
- Modify: `frontend/app/(app)/channels/page.test.tsx`
- Modify: `frontend/app/(app)/status-pages/page.tsx`
- Create: `frontend/app/(app)/status-pages/page.test.tsx`
- Modify: `frontend/components/app/check-detail.tsx`
- Modify: `frontend/test/check-detail.test.tsx`
- Modify: `frontend/components/app/edit-check-dialog.tsx`
- Modify: `frontend/test/edit-check-dialog.test.tsx`

**Interfaces:**

```ts
export interface Org {
  id: string;
  name: string;
  slug: string;
  role: string;
  plan: string;
  creatorUserId: string;
  creatorLabel: string;
  pingKey: string;
}
```

Canonical Apollo variables:

```ts
{ organizationId: activeOrg.id }
```

- [ ] **Step 1: Write failing auth/context and GraphQL document tests.**

Assert `fetchMe` requests `pingKey` directly on organizations and does not
request `projects`; canonical check/channel/status operations declare
`$organizationId: ID!` and contain no project variable. Keep the
project-oriented documents in `legacy-queries.ts` only for authenticated legacy
route validation.

- [ ] **Step 2: Run focused tests and verify RED.**

```bash
cd frontend
npm test -- test/auth-context.test.tsx lib/org-context.test.tsx lib/graphql-documents.test.ts
```

- [ ] **Step 3: Flatten frontend organization state.**

Remove the public `Project` type and `Org.projects`. Parse `pingKey` from `me`.
Keep active organization local-storage behavior unchanged. Update mocks and
fixtures to use one flat organization object.

- [ ] **Step 4: Convert dashboard, channels, and status pages test-first.**

Tests must assert:

- all query/create variables use the active organization ID;
- changing the active organization refetches organization-scoped data;
- channels ignore/remove the legacy `?projectId=` query parameter;
- no page renders `Default`, a project name, or a project selector;
- check cards link to `/${activeOrg.slug}/${check.slug}`;
- notification routing still loads channels once per active organization;
- status-page public URLs remain `/status/{slug}`.

Then replace `firstProject`, `projectId`, `projectName`, and `projectSlug` props
with `organizationId`, `organizationName`, and `organizationSlug`.

- [ ] **Step 5: Convert shared check detail/edit data.**

`CheckDetailData` uses canonical `organizationId` and channel queries use that
ID. Ownership checks compare `check.organizationId` to `org.id`; no component
searches `org.projects`.

- [ ] **Step 6: Run affected frontend suites.**

```bash
npm test -- app/\\(app\\)/dashboard/page.test.tsx app/\\(app\\)/channels/page.test.tsx app/\\(app\\)/status-pages/page.test.tsx test/check-detail.test.tsx test/edit-check-dialog.test.tsx
npx tsc --noEmit
```

- [ ] **Step 7: Commit the flat frontend workspace state.**

```bash
git add frontend/lib frontend/app/\\(app\\)/dashboard \
  frontend/app/\\(app\\)/channels/page.tsx frontend/app/\\(app\\)/channels/page.test.tsx \
  frontend/app/\\(app\\)/status-pages frontend/components/app/check-detail.tsx \
  frontend/components/app/edit-check-dialog.tsx frontend/test
git commit -m "feat(frontend): use organizations as workspaces"
```

---

### Task 7: Flatten agent connections, Telegram, verification, and ping-key UI

**Files:**

- Modify: `frontend/components/app/connect-agent-dialog.tsx`
- Modify: `frontend/components/app/connect-agent-dialog.test.tsx`
- Modify: `frontend/lib/agent-connection-config.ts`
- Modify: `frontend/lib/agent-connection-config.test.ts`
- Modify: `frontend/app/(app)/account/agent-connections/page.tsx`
- Modify: `frontend/app/(app)/account/agent-connections/page.test.tsx`
- Modify: `frontend/app/(app)/channels/telegram/connect/page.tsx`
- Modify: `frontend/app/(app)/channels/telegram/connect/page.test.tsx`
- Modify: `frontend/app/(public)/verify-email/page.tsx`
- Modify: `frontend/app/(public)/verify-email/page.test.tsx`
- Modify: `frontend/app/(app)/dashboard/page.tsx`
- Modify: `frontend/app/(app)/dashboard/page.test.tsx`

**Interfaces:**

```ts
export interface AgentConnectionConfigInput {
  organizationId: string;
  organizationName: string;
  apiUrl: string;
  token: string;
  client: AgentClient;
}
```

- [ ] **Step 1: Write failing integration-flow tests.**

Assert scoped-token creation sends `organizationId`, generated heartbeat
GraphQL uses `organizationId`, MCP configuration does not expose an internal
ID, Telegram connects to the active organization without a picker or
`?projectId=`, verification renders `organizationName`, and agent token rows
display organization names and filter to `token.organizationId === activeOrg.id`.

- [ ] **Step 2: Run focused tests and verify RED.**

```bash
npm test -- components/app/connect-agent-dialog.test.tsx lib/agent-connection-config.test.ts app/\\(app\\)/account/agent-connections/page.test.tsx app/\\(app\\)/channels/telegram/connect/page.test.tsx app/\\(public\\)/verify-email/page.test.tsx
```

- [ ] **Step 3: Implement organization-first agent configuration.**

Rename project props/types/copy to organization equivalents. Direct API curl
configuration sends:

```json
{
  "query": "mutation CreateHeartbeat($organizationId: ID!) { createCheck(organizationId: $organizationId, name: \"agent-heartbeat\", periodSeconds: 300, graceSeconds: 60) { id } }",
  "variables": { "organizationId": "resolved-active-organization" }
}
```

Preserve all shell escaping and token-redaction tests. Scoped MCP connections
remain scope-free to the caller because the bound credential injects its
organization. The connection-history page filters live tokens by canonical
`organizationId`; deleted-workspace legacy records use neutral unavailable
copy and never display a project name.

- [ ] **Step 4: Implement active-organization Telegram and verification UI.**

Use `activeOrg.id` for `CONNECT_TELEGRAM_CHANNEL`, redirect to `/channels`,
remove project selection/query-string recovery, and retain challenge
expiry/error dialogs. Render `organizationName` in email verification and keep
legacy `projectName` only as an API fallback during rolling deployment; never
render the internal `Default` value.

- [ ] **Step 5: Run focused and full frontend tests.**

```bash
npm test -- components/app/connect-agent-dialog.test.tsx lib/agent-connection-config.test.ts app/\\(app\\)/account/agent-connections/page.test.tsx app/\\(app\\)/channels/telegram/connect/page.test.tsx app/\\(public\\)/verify-email/page.test.tsx
npm test
```

- [ ] **Step 6: Commit organization-first connection flows.**

```bash
git add frontend/components/app/connect-agent-dialog* \
  frontend/lib/agent-connection-config* \
  frontend/app/\\(app\\)/account/agent-connections \
  frontend/app/\\(app\\)/channels/telegram/connect \
  frontend/app/\\(public\\)/verify-email frontend/app/\\(app\\)/dashboard
git commit -m "feat(frontend): flatten workspace connection flows"
```

---

### Task 8: Add canonical check routes and organization-only moves

**Files:**

- Create: `frontend/app/(app)/[org]/[check]/page.tsx`
- Modify: `frontend/app/(app)/[org]/[project]/[check]/page.tsx`
- Modify: `frontend/app/(app)/checks/[id]/page.tsx`
- Create: `frontend/components/app/legacy-check-route-redirect.tsx`
- Modify: `frontend/components/app/move-check-dialog.tsx`
- Modify: `frontend/test/move-check-dialog.test.tsx`
- Modify: `frontend/test/check-slug-route.test.tsx`
- Modify: `frontend/test/check-id-route.test.tsx`
- Modify: `frontend/app/(app)/dashboard/page.tsx`
- Modify: `frontend/app/(app)/dashboard/page.test.tsx`
- Modify: `frontend/lib/queries.ts`

**Interfaces:**

```ts
export interface MoveDestination {
  organizationId: string;
  organizationSlug: string;
  checkSlug: string;
}
```

```graphql
query CheckByOrganizationSlug($orgSlug: String!, $checkSlug: String!) {
  checkByOrganizationSlug(orgSlug: $orgSlug, checkSlug: $checkSlug) {
    id
    organizationId
    notificationChannelIds
    name
    slug
    type
    status
    pingSlug
    periodSeconds
    graceSeconds
    schedule
    tz
    nextExpectedAt
    target
    method
    expectedStatus
    intervalSeconds
    timeoutMs
    events {
      id
      status
      timestamp
      error
      responseTimeMs
      statusCode
    }
  }
}
```

- [ ] **Step 1: Write failing canonical-route tests.**

Assert the two-segment page queries by organization/check slug, rename replaces
with `/${org}/${newSlug}`, moves replace with
`/${destinationOrg}/${checkSlug}`, and generated links contain no project
segment.

- [ ] **Step 2: Write failing legacy redirect tests.**

The old three-segment route must execute the legacy authenticated
`checkBySlug(orgSlug, projectSlug, checkSlug)` query. Only a successful complete
tuple calls Next.js `permanentRedirect('/{org}/{returnedCheck.slug}')`; a
missing, inaccessible, or mismatched tuple renders the existing not-found/error
state and never redirects. The ID route resolves the check's
organization/check slug and redirects to the same canonical path.

- [ ] **Step 3: Write failing organization-only move-dialog tests.**

Assert one destination organization selector, no project selector, preview
`/destination/nightly-backup`, variables
`{ checkId, destinationOrganizationId }`, owner-only filtering, cache
invalidation, active-org update before navigation, and current error/closing
semantics.

- [ ] **Step 4: Run route and move tests and verify RED.**

```bash
npm test -- test/check-slug-route.test.tsx test/check-id-route.test.tsx test/move-check-dialog.test.tsx app/\\(app\\)/dashboard/page.test.tsx
```

- [ ] **Step 5: Implement canonical and legacy route components.**

The canonical page retains polling/edit/refetch behavior. The legacy redirect
component performs the authenticated legacy query before calling
`permanentRedirect`; it must not build a redirect from raw path parameters
alone. The redirect remains a client-side authenticated redirect because JWT
storage is localStorage; do not introduce cookies or a REST proxy.

- [ ] **Step 6: Implement organization-only moves and navigation.**

Use `check.organizationId` to identify the source organization, filter other
owned organizations, submit `destinationOrganizationId`, return no project
slug in `MoveDestination`, and preserve best-effort Apollo eviction/refetch
after the committed mutation.

- [ ] **Step 7: Run route suites, type-check, and build.**

```bash
npm test -- test/check-slug-route.test.tsx test/check-id-route.test.tsx test/move-check-dialog.test.tsx app/\\(app\\)/dashboard/page.test.tsx
npx tsc --noEmit
npm run build
```

- [ ] **Step 8: Commit canonical routes and moves.**

```bash
git add frontend/app/\\(app\\)/\\[org\\] frontend/app/\\(app\\)/checks \
  frontend/components/app/legacy-check-route-redirect.tsx \
  frontend/components/app/move-check-dialog.tsx frontend/test \
  frontend/app/\\(app\\)/dashboard frontend/lib/queries.ts
git commit -m "feat(frontend): flatten check routes and moves"
```

---

### Task 9: Remove project terminology from organization and admin surfaces

**Files:**

- Modify: `frontend/app/(app)/organizations/page.tsx`
- Modify: `frontend/app/(app)/organizations/page.test.tsx`
- Modify: `frontend/app/(admin)/admin/page.tsx`
- Create: `frontend/app/(admin)/admin/page.test.tsx`
- Modify: `frontend/app/(admin)/admin/organizations/page.tsx`
- Create: `frontend/app/(admin)/admin/organizations/page.test.tsx`
- Modify: `frontend/app/(admin)/admin/organizations/[id]/page.tsx`
- Modify: `frontend/app/(admin)/admin/organizations/[id]/page.test.tsx`
- Modify: `frontend/app/(admin)/admin/checks/page.tsx`
- Create: `frontend/app/(admin)/admin/checks/page.test.tsx`
- Modify: `frontend/components/admin/admin-sidebar.tsx`
- Modify: `frontend/lib/admin-queries.ts`
- Modify: `frontend/lib/admin-types.ts`

**Presentation contract:**

- Organization management warns about checks, channels, status pages, members,
  and data without mentioning projects.
- Admin overview does not display `totalProjects`.
- Admin organization lists/details do not display `projectCount`.
- Admin check rows display the organization name only.
- Admin navigation labels the resource section `Checks`, not
  `Projects & Checks`.
- Admin GraphQL documents do not request `projectId`, `projectName`,
  `projectCount`, or `totalProjects`.

- [ ] **Step 1: Write failing organization/admin presentation tests.**

Use an internal project fixture named exactly `Default` and assert it never
renders. Cover organization delete/leave dialogs, admin overview metrics,
organization list/detail summaries, check ownership text, and sidebar labels.

- [ ] **Step 2: Run the focused tests and verify RED.**

```bash
npm test -- app/\\(app\\)/organizations/page.test.tsx app/\\(admin\\)/admin/page.test.tsx app/\\(admin\\)/admin/organizations/page.test.tsx app/\\(admin\\)/admin/organizations/\\[id\\]/page.test.tsx app/\\(admin\\)/admin/checks/page.test.tsx
```

- [ ] **Step 3: Remove project fields and copy from frontend admin contracts.**

Stop selecting and typing project counts/names/IDs in frontend admin queries.
Render organization counts, member counts, checks, and organization ownership
using fields already available from the admin API. Keep the deprecated admin
GraphQL project fields server-side for this compatibility release; they are no
longer part of the product UI.

- [ ] **Step 4: Run frontend presentation tests and type-check.**

```bash
npm test -- app/\\(app\\)/organizations/page.test.tsx app/\\(admin\\)/admin/page.test.tsx app/\\(admin\\)/admin/organizations/page.test.tsx app/\\(admin\\)/admin/organizations/\\[id\\]/page.test.tsx app/\\(admin\\)/admin/checks/page.test.tsx
npx tsc --noEmit
```

- [ ] **Step 5: Commit the final visible flattening.**

```bash
git add frontend/app/\\(app\\)/organizations frontend/app/\\(admin\\) \
  frontend/components/admin/admin-sidebar.tsx frontend/lib/admin-queries.ts \
  frontend/lib/admin-types.ts
git commit -m "refactor(frontend): remove visible project concepts"
```

---

### Task 10: Make MCP organization-first with one-release project compatibility

**Files:**

- Modify: `integrations/mcp/src/tools.ts`
- Modify: `integrations/mcp/src/credential.ts`
- Modify: `integrations/mcp/src/gql.ts`
- Modify: `integrations/mcp/test/tools.test.ts`
- Modify: `integrations/mcp/test/credential.test.ts`
- Modify: `integrations/mcp/test/server.test.ts`
- Modify: `integrations/mcp/test/email-verification-tool-boundary.ts`
- Modify: `integrations/mcp/README.md`

**Interfaces:**

```ts
type WorkspaceToolArgs = {
  organizationId?: string;
  projectId?: string;
};

function readWorkspaceSelector(args: Record<string, unknown>):
  | { organizationId: string }
  | { projectId: string };
```

The canonical discovery tool is `list_organizations`; deprecated
`list_projects` remains registered for this release. Workspace-scoped tools
expose optional `organizationId` and deprecated `projectId` descriptions and
enforce exactly one in the handler.

- [ ] **Step 1: Write failing organization-first tool tests.**

Add tests proving:

- `list_organizations` returns organization ID/name/plan/creator/ping key and
  contains no project label;
- `list_projects` retains its old output for compatibility;
- list/create check, list/create channel, and ping-key tools send
  `organizationId` canonically;
- the same tools accept legacy `projectId`;
- both/neither scope fails before `gql` is called;
- `create_project` remains absent.

- [ ] **Step 2: Write failing scoped-credential tests.**

`Credential` gains `organizationId`/`organizationName` while retaining project
fields. A scoped credential removes both scope fields from exposed tool schemas
and injects its canonical organization:

```ts
definition.handler(
  { ...args, organizationId: credential.organizationId },
  gql,
);
```

Fail closed if `PROJECT_SCOPED` has neither canonical organization ID nor a
legacy project ID. Retain legacy injection only when talking to an older API
that returned no organization ID.

- [ ] **Step 3: Run MCP tests and verify RED.**

```bash
cd integrations/mcp
npm test -- tools.test.ts credential.test.ts server.test.ts
```

- [ ] **Step 4: Implement canonical tools and compatibility selector.**

Add `list_organizations`, keep `list_projects`, convert canonical descriptions
and response copy to “organization”, and send GraphQL variable/argument pairs
selected by `readWorkspaceSelector`. Resource-ID tools remain unchanged.
Update safe error normalization to say “organization workspace” while still
recognizing legacy backend messages containing “project”.

- [ ] **Step 5: Update tool catalogs, docs, and package validation.**

Remove `create_project` from all catalogs and email-verification boundary
fixtures, document the one-release `projectId` compatibility, and show only
organization-first examples.

```bash
npx tsc --noEmit
npm test
npm run build
```

- [ ] **Step 6: Commit MCP compatibility.**

```bash
git add integrations/mcp
git commit -m "feat(mcp): use organization workspaces"
```

---

### Task 11: Document the compatibility release and validate every boundary

**Files:**

- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/DEPLOYMENT.md`
- Modify: `integrations/mcp/README.md` only if Task 10 did not complete all release notes
- Modify only when generated behavior requires it: `api/src/schema.gql`

**Documentation contract:**

- Organization is the only public workspace.
- One internal project remains per organization.
- `projectId` compatibility lasts this release only.
- `createProject` is already removed.
- Self-hosters run the read-only preflight before upgrading.
- The migration aborts without writes for zero/multiple project data.
- Existing project-scoped tokens remain valid.
- The next cleanup release removes deprecated project surface but does not
  automatically delete the internal table.
- Dokploy remains API → frontend → worker and infrastructure Compose is
  untouched.

- [ ] **Step 1: Add a documentation contract test through repository searches.**

Run the searches before editing and record expected failures:

```bash
grep -RIn "projects\\[0\\]\\|Select project\\|create_project\\|createProject" \
  frontend integrations/mcp/src README.md docs/ARCHITECTURE.md
grep -RIn "projectId" frontend/app frontend/components frontend/lib/queries.ts
```

After implementation, canonical product/MCP source must have no matches except
the explicitly named legacy redirect/query and compatibility tests.

- [ ] **Step 2: Update public architecture, contributor, and deployment docs.**

Describe the internal workspace facade and preflight command:

```bash
cd database
npm run preflight:organization-workspaces
```

Do not include production counts, IDs, hosts, credentials, or commands that
echo the external environment. State that the API must be ready before the
frontend rollout and the frontend before the worker rollout.

- [ ] **Step 3: Run the complete local validation matrix.**

With a disposable PostgreSQL/Redis test environment:

```bash
cd database
npm run generate
npx prisma validate
npm test

cd ../api
npm run lint
npx tsc --noEmit
npm test
npm run test:e2e
npm run build

cd ../frontend
npm run lint
npx tsc --noEmit
npm test
npm run build

cd ../worker
npx tsc --noEmit
npm test

cd ../integrations/mcp
npx tsc --noEmit
npm test
npm run build

cd ../..
bash scripts/test/docker-entrypoints.test.sh
git diff --check
```

- [ ] **Step 4: Audit worker and deployment compatibility.**

Verify no worker job interface changed:

```bash
git diff refs/remotes/systemvitals/main...HEAD -- worker/src worker/cli
```

Expected: empty, apart from generated database-client effects that are not
committed. Verify no stateful infrastructure change:

```bash
git diff --exit-code refs/remotes/systemvitals/main...HEAD -- \
  docker-compose.infrastructure.yml
```

Expected: exit 0.

- [ ] **Step 5: Audit tracked content for secrets and unintended artifacts.**

```bash
git status --short
git diff --stat refs/remotes/systemvitals/main...HEAD
git ls-files | grep -E '(^|/)\\.env($|\\.)|\\.pem$|\\.key$|\\.p12$|\\.sql$|\\.dump$' || true
git grep -nE 'BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|postgres(ql)?://[^[:space:]]+:[^[:space:]]+@' -- ':!docs/superpowers/*' || true
```

Inspect every match; only safe examples and migration SQL may remain.

- [ ] **Step 6: Commit public documentation.**

```bash
git add AGENTS.md README.md docs/ARCHITECTURE.md docs/DEPLOYMENT.md \
  integrations/mcp/README.md api/src/schema.gql
git commit -m "docs: document organization workspace compatibility"
```

---

### Task 12: Review, merge, and verify the zero-downtime production rollout

**Files:**

- No source files; this is the protected release and production verification gate.

- [ ] **Step 1: Run two-stage review on every implementation task.**

For Tasks 1–11, a fresh specification reviewer checks the task against this
plan and design, then a fresh quality reviewer checks security, concurrency,
tests, maintainability, and scope. Resolve every important finding with a new
test and focused commit before continuing.

- [ ] **Step 2: Run the production read-only preflight without exposing secrets.**

Load `../nihey/.env` into the process using the existing private operational
method, then run:

```bash
cd database
npm run preflight:organization-workspaces
```

Expected: success and no incompatible organizations. Do not paste environment
values or production IDs into commits, PR text, or logs.

- [ ] **Step 3: Push and open one protected compatibility-release PR.**

Use the public `SystemVitals/systemvitals` remote, summarize the invariant,
compatibility window, preflight, route change, token behavior, and rollback
boundary. Wait for these required checks:

- `database / api / worker`
- `frontend`
- `deployment images`
- `integrations/mcp`

- [ ] **Step 4: Merge only after all checks and reviews pass.**

Confirm the merge target is public `main`. The merge triggers the existing
Dokploy applications; do not trigger the infrastructure Compose application.

- [ ] **Step 5: Observe the serialized rollout and smoke continuously.**

Require readiness in this order:

1. API: migration complete and `/health/ready` healthy;
2. frontend: `/api/health` healthy and organization-first UI functional;
3. worker: readiness marker healthy and existing probe/notification jobs
   processing.

Run:

```bash
bash scripts/smoke-zero-downtime.sh \
  --duration 900 \
  --interval 1 \
  --output /tmp/systemvitals-organization-workspace-smoke.jsonl
```

Expected: zero failed probes.

- [ ] **Step 6: Run authenticated production checks.**

Verify:

- organization switching and creation;
- dashboard check list/create;
- canonical organization/check URL;
- validated legacy route redirect;
- channel list/create and per-check toggles;
- status-page management and unchanged public page;
- Telegram connection path;
- ping-key rotation;
- organization-only check move;
- new organization-scoped token and existing project-scoped token;
- canonical MCP organization tools and legacy `list_projects`/`projectId`;
- one future DOWN and one recovery notification;
- no infrastructure Compose deployment or restart.

- [ ] **Step 7: Record the cleanup boundary.**

Open or document the immediately following cleanup release scope: remove
deprecated GraphQL project arguments/fields/queries, MCP project compatibility,
and legacy route code. Do not include physical `Project` table deletion without
a separate approved design.
