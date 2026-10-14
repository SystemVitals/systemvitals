# Account Personal Access Tokens Implementation Plan

> Execute inline using the executing-plans and test-driven-development skills.

**Goal:** Let an agent manage the user's product account and obtain hosted billing links.

**Architecture:** Reuse ApiToken hashing, ownership and lifecycle with an explicit
`account:manage` scope and `ACCOUNT` credential mode. Route account tokens through
existing services and a public operation allowlist; leave credential management
and password guards session-only.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Next.js/React, Apollo, TypeScript, MCP.

**Spec:** `docs/superpowers/specs/2026-10-14-account-personal-access-tokens-design.md`

### Task 1: Account credential policy and lifecycle

- [x] Add failing tests to `api/src/tokens/token-policy.spec.ts`,
  `api-token.strategy.spec.ts`, `tokens.service.spec.ts`, and `tokens.resolver.spec.ts`.
  Cover cross-workspace checks, operational access, denied password/token/admin
  operations, invalid workspace-bound/mixed credentials, and credential discovery.
- [x] Run `cd api && npm test -- --runInBand tokens` and observe missing support.
- [x] Add `account:manage` to TokenCapability. A valid account token has exactly
  that capability, no legacy scopes and no project binding. Explicitly allow public
  product operations; reject all others. RequireCheckAccess still checks resource
  ownership in the calling service. Add createPersonalAccessToken(name, expirationDays)
  under the existing JWT-only resolver. Require a trimmed nonempty name and integer
  expiration of 1–3650 days when supplied. Store only hash/prefix and scope.
- [x] Run focused token tests and TypeScript; expect all passing.

### Task 2: Account operations and billing GraphQL

- [x] Write `api/test/personal-access-tokens.e2e-spec.ts` to exercise creation,
  cross-organization product operations, status pages, role/membership changes,
  revocation/expiry/suspension, credential/password/admin denials, and GraphQL
  billing service delegation without external Stripe calls.
- [x] Add guard tests for sessions/account tokens, legacy/scoped rejection and
  impersonation rejection. Run tests and observe the absent account guard/mutations.
- [x] Create `api/src/tokens/account-access.guard.ts`, export its guard via
  TokensCoreModule, and use its decorator for moveCheck and Telegram handshake.
  Add `api/src/billing/billing-actions.resolver.ts` with validated paid plan and
  interval arguments and createBillingCheckout/createBillingPortal returning URL.
  Delegate to BillingService for the principal's userId. Preserve REST endpoints.
- [x] Run API lint, typecheck, unit tests and full e2e suite; inspect schema snapshots.

### Task 3: MCP account tools

- [x] Add failing `integrations/mcp/test/account-tools.test.ts` tests for ACCOUNT
  tool discovery, exclusion of credential/password operations, correct GraphQL
  fields/variables, and error propagation.
- [x] Create `integrations/mcp/src/account-tools.ts` for the supplemental tools.
  Add ACCOUNT to credential.ts and return the existing catalog plus account tools
  only for that mode. Keep scoped/session/legacy catalogs compatible.
- [x] Run `cd integrations/mcp && npx tsc --noEmit && npm test`; expect unit and
  package smoke tests passing.

### Task 4: Account UI and documentation

- [x] Add failing account wizard tests alongside connect-agent-dialog tests.
  Check account mutation variables, copy/one-time display, expiration, and scope copy.
- [x] Parameterize ConnectAgentDialog with account/organization props, reuse the
  same result and navigation protection, and select CREATE_PERSONAL_ACCESS_TOKEN
  for account creation. Show its button in account connection history and label
  account:manage as Manage account. Add the GraphQL document in queries.ts.
- [x] Update root AGENTS.md, README.md and API/MCP documentation with boundaries,
  creation/revocation instructions and billing's hosted completion requirement.
- [x] Run frontend lint/typecheck/tests and re-run checks affected by final fixes.

### Review focus

Check that deleted scoped bindings never widen into account access; account tokens
cannot mint tokens, change passwords or inherit an issuer's platform-admin powers.
Confirm every GraphQL data operation remains organization-first, current roles are
checked by services, secret creation bypasses Apollo cache, and legacy tool catalogs
retain their authorization boundary.

## Execution record

Implemented on `feat/account-personal-access-tokens` in the shared checkout.
Validation used Node.js 22.23.3, an isolated PostgreSQL/Redis test environment,
and fake billing providers; no production infrastructure or credentials were used.

- API lint and TypeScript passed; 923 unit and 397 e2e tests passed.
- Frontend lint and TypeScript passed; 542 tests passed. Regenerated stale local
  Next.js route types before typechecking.
- MCP TypeScript, 154 tests, build and packed-package smoke passed.
- `git diff --check` passed.
- Independent review found one important recovery issue: navigating to connection
  history on the already-mounted account page did not refresh a token whose
  creation response was lost. Added explicit recovery refresh and a regression
  test; observed failure before the fix and success in the full frontend suite.
  No critical or minor findings remain.
- Preserved the existing impersonation rejection message for compatibility.
- Added public-only billing type isolation and its e2e regression test.
- MCP publication and deployment are release steps, outside this local change.

## PR follow-up

The user authorized PR creation and merge and asked to retire the obsolete agent
page. Moved controls to `frontend/components/app/personal-access-tokens.tsx` in
Account settings, with account-wide history and a legacy URL redirect. Removed
dashboard scoped-token entry points and the separate navigation item. Regression
tests were observed failing before these layout changes. Fixed Claude CLI name
validation: an isolated CLI test rejected `SystemVitals account` and accepted the
normalized generated name. npm confirms the MCP package is unpublished (E404).

CI follow-up: all API e2e tests passed, but watchdog fixture cleanup selected every
`@test.invalid` user, colliding with parallel alert-handler fixtures. Restricted
cleanup to the watchdog-test prefix and added an unrelated-account fixture that
reproduced the failure before the fix. Worker TypeScript and all 252 tests pass
against the isolated test database. The user explicitly confirmed token controls
belong directly in Account settings with the old agent page removed.
