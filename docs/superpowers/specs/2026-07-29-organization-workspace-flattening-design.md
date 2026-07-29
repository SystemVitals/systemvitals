# Organization Workspace Flattening Design

**Date:** 2026-07-29
**Status:** Approved

## Summary

Flatten SystemVitals' public workspace model so that an organization is the
only workspace users and API consumers need to understand. Each organization
continues to own exactly one internal `Project` row, but that row becomes an
implementation detail used by the existing database relations, authorization
policy, workers, and job payloads.

The compatibility release introduces organization-first GraphQL, MCP, routes,
and frontend behavior while accepting existing project-oriented operations for
one release. The following cleanup release removes that deprecated public
surface. Physically deleting the `Project` table is a separate, optional future
change.

## Context

Projects currently scope checks, channels, status pages, API tokens, ping keys,
worker jobs, and authorization. Organization and signup creation already create
a project named `Default`, and the frontend generally selects
`activeOrg.projects[0]`. However, there is no product flow for managing multiple
projects, so the visible hierarchy suggests a capability the product does not
actually support.

The production preflight performed during design found:

- 11 organizations;
- 11 projects;
- no organization with zero projects;
- no organization with multiple projects.

The production data already satisfies the proposed one-workspace invariant.
Self-hosted installations must still be validated rather than assumed to match
production.

## Goals

- Make an organization the single visible workspace boundary.
- Enforce at most one internal project per organization in PostgreSQL.
- Continue creating the internal workspace transactionally with every
  organization.
- Resolve organization IDs to internal project IDs in one shared API
  abstraction.
- Preserve existing project-oriented integrations for exactly one
  compatibility release.
- Keep existing project-scoped API tokens valid during the compatibility
  release.
- Preserve all ownership and cross-organization authorization guarantees.
- Preserve the existing automatic, zero-downtime Dokploy deployment chain.
- Migrate without selecting, merging, or deleting user data.

## Non-Goals

- Supporting multiple projects within an organization.
- Renaming projects or exposing workspace management.
- Merging data from incompatible self-hosted multi-project organizations.
- Deleting the `Project` table or immediately rewriting every foreign key.
- Changing notification, check execution, status-page, or worker behavior.
- Changing public status-page URLs.
- Changing stateful infrastructure or
  `docker-compose.infrastructure.yml`.

## Chosen Architecture

### Internal workspace facade

Retain `Project` as the internal relational workspace for this migration.
Checks, channels, status pages, ping keys, scoped tokens, and worker jobs may
continue to reference `projectId` internally.

Add a shared API workspace resolver with these responsibilities:

1. accept exactly one public identifier during the compatibility release:
   canonical `organizationId` or deprecated `projectId`;
2. verify that the authenticated principal can access the owning
   organization;
3. resolve the organization's sole project;
4. fail on missing or structurally invalid workspace data;
5. return the internal project ID to existing services and authorization
   policy.

Resource operations that already identify a check, channel, token, or status
page by its own ID continue resolving ownership from that resource. They do not
gain redundant organization arguments.

This facade keeps the migration focused on the public model while avoiding a
high-risk, all-at-once rewrite of database relations and queued work.

### One project per organization

Add a unique database constraint on `projects.organization_id`. The constraint
enforces at most one project per organization. Application transactions
continue to enforce the complementary at-least-one rule by creating the
`Default` project whenever an organization is created.

The internal project's name and slug remain only for rolling compatibility and
legacy URL resolution. They are not user-editable or shown in the canonical
product.

Remove the ability to create an additional project. `createProject` is the one
public operation removed in the compatibility release because retaining it
would directly violate the new invariant. Organization creation remains the
only supported way to create a workspace.

### Alternatives considered

1. **Frontend-only flattening:** hide projects but leave the API and database
   capable of creating several. This was rejected because hidden multi-project
   state would remain possible and every client would continue depending on
   `projects[0]`.
2. **Immediate physical removal:** move every project foreign key directly to
   organizations and delete `Project`. This was rejected for the first
   migration because it expands risk across authorization, workers, tokens,
   routes, and every resource table without delivering additional product
   value.
3. **Internal workspace facade:** enforce one project, make organizations
   canonical, and retire compatibility in a later release. This is the chosen
   approach because it delivers the desired product model with a reversible,
   zero-data-loss rollout.

## Database Migration

### Read-only preflight

Provide a preflight command or SQL report that returns:

- organizations with no project;
- organizations with more than one project;
- the project count for every incompatible organization;
- the affected organization IDs.

The deployment migration repeats this validation immediately before applying
the constraint so a race cannot invalidate an earlier report.

If any incompatible organization exists, the migration aborts with an
actionable error and changes no data. It never:

- selects one project arbitrarily;
- moves resources between projects;
- merges projects;
- creates a missing project without operator review;
- deletes projects or project-owned resources.

An operator must reconcile incompatible self-hosted data deliberately and
rerun the migration. Production currently passes the preflight.

### Schema invariant

After a successful preflight, add a unique constraint/index on
`projects.organization_id` and reflect it in the Prisma schema. Keep existing
foreign keys and cascades. Organization deletion therefore continues cascading
through its internal workspace to project-owned resources.

Organization creation and signup flows must continue creating the organization
and its internal project in the same transaction. Tests must prove that a
failed workspace creation cannot leave an organization without a project.

No user data is backfilled, merged, renamed, or deleted.

## GraphQL Compatibility Contract

### Canonical organization inputs

Project-scoped operations gain `organizationId` as their canonical input.
During the compatibility release, their existing `projectId` input remains
available but deprecated. Both inputs are nullable in the schema so the
resolver can enforce an exclusive-or rule:

- one `organizationId`: resolve the organization's internal workspace;
- one `projectId`: use the legacy compatibility path;
- both identifiers: reject with a validation error;
- neither identifier: reject with a validation error.

This applies to project-scoped check creation/listing, channel
creation/listing, status-page creation/listing, Telegram connection, ping-key
management, and scoped-token creation. Operations addressed by a resource ID
remain resource-addressed.

Canonical response models expose `organizationId`. Existing `projectId` fields
remain present and marked deprecated for the compatibility release. Legacy
project collections remain readable and contain exactly one project per
organization.

Project-specific operations that need organization-first names receive
canonical organization operations. For example, ping-key regeneration is
available through an organization-oriented mutation while the existing
project-oriented mutation remains as a deprecated alias for one release.

### Token compatibility

Existing project-scoped API tokens remain valid and keep their stored internal
project scope. New clients create scoped tokens with `organizationId`; the
service resolves and stores the same internal project ID. Token responses add
canonical `organizationId` while retaining deprecated `projectId` for the
compatibility release.

Unscoped legacy tokens, explicit check capabilities, and current token
authorization behavior do not change. Every resolved organization must still
pass the existing membership and capability checks.

### Immediate invariant exception

`createProject` is removed from the public schema in this release rather than
deprecated for another release. A deprecated implementation that still creates
projects would break the database invariant, while an implementation that
silently returns the existing workspace would give misleading mutation
semantics. Public documentation must explain that every organization
automatically contains its workspace.

## MCP Compatibility Contract

The MCP integration becomes organization-first:

- add `list_organizations` as the canonical discovery tool;
- accept `organizationId` on workspace-scoped tools;
- return canonical organization identifiers in results;
- update prompts, descriptions, examples, and documentation to describe
  organizations rather than projects.

`list_projects`, project-oriented parameters, and deprecated project
identifiers remain operational for exactly the compatibility release. They
resolve through the same API facade and must retain existing authorization.
Providing both organization and project identifiers, or neither when a scope
is required, returns a clear validation error.

The cleanup release removes the deprecated tools, arguments, response fields,
and documentation.

## Product and Frontend Behavior

Organizations become the only visible workspace:

- keep the organization selector as the primary switcher;
- remove project labels, names, selectors, and the internal `Default` name;
- load dashboard checks, channels, status pages, agents, and ping-key settings
  using the active organization;
- make Telegram connection organization-scoped with no project picker;
- make the move-check dialog select only a destination organization;
- resolve a move to that organization's sole internal workspace;
- retain the current ownership and authorization checks around moves.

Frontend queries and mutations use canonical `organizationId` inputs and must
not depend on `activeOrg.projects[0]`.

### Check routes

The canonical authenticated check route becomes:

```text
/{organization}/{check}
```

The existing route remains as a compatibility redirect:

```text
/{organization}/{project}/{check}
  -> /{organization}/{check}
```

The legacy route resolves the organization, internal project, and check before
issuing a permanent redirect, preventing arbitrary or cross-organization
redirects. All generated links, breadcrumbs, post-create navigation, and
post-move navigation use the canonical route.

Public status-page routes remain unchanged.

## Authorization and Error Handling

- Unknown or inaccessible organization: use the existing non-disclosing
  not-found/authorization behavior.
- Organization without a project: report an internal workspace integrity
  error; never select or create data implicitly during a read.
- Organization with multiple projects: report an internal workspace integrity
  error; the database constraint prevents this after migration.
- Deprecated project outside the principal's organization membership: reject
  through the existing project access policy.
- Both or neither compatibility identifiers: return a stable input validation
  error.
- Destination organization in a check move: require the same membership and
  plan checks currently required for the destination project.
- Legacy URL with mismatched organization, project, or check: return not found,
  not a redirect.
- Unique-constraint violation during concurrent workspace creation: roll back
  the organization transaction and return the normal conflict/integrity error.

No error response should reveal the existence of an organization, project, or
resource that the principal cannot access.

## Rollout

Use protected pull requests and the existing serialized Dokploy deployment
chain. Stateful infrastructure and the private `../nihey/.env` deployment
configuration remain untouched.

### Compatibility release

1. Run the read-only production preflight.
2. Apply the non-destructive unique-constraint migration.
3. Deploy the API first. It accepts both legacy project identifiers and
   canonical organization identifiers before any client changes.
4. Deploy the frontend. It switches to organization-first operations and
   canonical routes while the API still accepts rollback traffic from the old
   frontend.
5. Deploy the worker. Internal project IDs and existing job payloads remain
   compatible, so old and new workers may overlap safely.
6. Deploy the MCP package/integration changes.
7. Run authenticated production smoke tests for organizations, checks,
   channels, status pages, ping keys, tokens, Telegram paths, redirects, MCP,
   worker execution, and notifications.

The current Dokploy automatic deployment trigger remains merge-driven and
keeps the API-to-frontend-to-worker ordering. Infrastructure Compose is not
redeployed.

### Cleanup release

The immediately following compatibility cleanup removes:

- deprecated GraphQL `projectId` inputs and response fields;
- legacy project collections and project-oriented aliases;
- project-oriented MCP tools, arguments, and results;
- the old three-segment check route and its redirect code once the agreed
  compatibility window ends;
- compatibility-only tests and documentation.

The cleanup does not have to delete the internal `Project` table. That physical
normalization requires a separate design and migration if its maintenance cost
later justifies the risk.

## Rollback

The compatibility release deletes no project or project-owned data. If an
application deployment fails:

- the old frontend continues using `projectId`, which the new API accepts;
- the new frontend can be rolled back independently;
- old and new workers continue consuming the unchanged internal project IDs;
- existing tokens remain valid;
- the unique constraint may remain because the old application already creates
  one default project per organization in normal product flows.

If the migration preflight fails, no application release proceeds and the
currently deployed containers remain active. Reverting the unique constraint
is unnecessary for an application rollback and must not be used to restore
multi-project creation.

## Testing

### Database

- Preflight passes for exactly one project per organization.
- Preflight reports organization IDs and counts for zero-project cases.
- Preflight reports organization IDs and counts for multi-project cases.
- Failing preflight changes no data and does not add the constraint.
- Unique organization-to-project constraint rejects a second project.
- Organization creation transaction creates exactly one internal project.
- Failed project creation rolls back organization creation.
- Organization deletion retains existing cascades.

### API

- Every migrated project-scoped operation accepts `organizationId`.
- Every deprecated operation still accepts `projectId`.
- Both and neither identifiers are rejected consistently.
- Canonical responses include `organizationId`.
- Deprecated responses retain `projectId` for the compatibility release.
- `createProject` is absent.
- Existing project-scoped tokens remain valid.
- Organization-scoped token creation stores and enforces the internal scope.
- Cross-user and cross-organization access is rejected without information
  disclosure.
- Check moves resolve the destination organization's sole workspace.
- Missing or structurally invalid workspaces fail safely.

### Frontend

- No user-facing project name, `Default` label, or project selector remains.
- Active organization changes refetch organization-scoped data.
- Dashboard, channels, status pages, agents, ping keys, and Telegram flows use
  the active organization.
- Move-check selects an organization and navigates to the canonical route.
- New links use `/{organization}/{check}`.
- A valid old route permanently redirects to the canonical route.
- Mismatched or inaccessible old routes return not found.

### MCP

- Organization discovery and organization-scoped tools work canonically.
- Legacy project tools and arguments work for the compatibility release.
- Both/neither identifier validation matches GraphQL.
- Cross-organization access remains blocked.
- Tool descriptions and examples contain no canonical project workflow.

### Worker and deployment

- Existing internal project-scoped jobs are unchanged.
- API and worker versions can overlap without job failures.
- Old frontend requests work after the API deploy.
- New frontend requests work before the worker deploy completes.
- Dokploy deploys API, frontend, then worker from a merge.
- Post-deploy probes show no downtime.
- DOWN and recovery notification behavior remains unchanged.

## Documentation

Update public documentation in the implementation release:

- root and relevant subproject `AGENTS.md` files for the organization-workspace
  invariant and compatibility rule;
- `README.md` and architecture documentation where the public hierarchy is
  described;
- GraphQL examples and generated schema snapshots;
- MCP README, tool descriptions, and examples;
- deployment documentation for the preflight and zero-downtime ordering;
- release notes that identify the compatibility window and the immediate
  removal of `createProject`.

Do not add production data, credentials, internal hosts, Dokploy identifiers,
or values from `../nihey/.env` to public documentation or source control.
