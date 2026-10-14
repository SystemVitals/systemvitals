# Account personal access tokens

Status: Approved by the user on 2026-10-14.

Create an account-wide personal access token from Account > Personal access tokens.
It delegates product management and billing checkout/portal links to an agent.
Password changes, token administration, and platform administration remain outside
its authority. Current organization membership, roles, quotas, last-owner rules,
and recipient verification continue to govern every operation.

Use the existing hashed `svt_` token storage with the explicit `account:manage`
scope, no organization binding, and credential mode `ACCOUNT`. Only a login
session can issue, list, or revoke these credentials. Support optional expiration,
one-time secret display, immediate revocation, and last-used tracking. Reject
malformed account tokens with workspace bindings or mixed scopes. Existing scoped
and legacy credentials retain their current access.

Account access uses an explicit public-operation allowlist. Add a reusable guard
for a real account session or account token, rejecting impersonation where an
account session was previously required. Allow check moves, allowance queries,
and Telegram connection operations; Telegram still requires its existing handshake.
Expose billing checkout and portal as GraphQL mutations backed by BillingService;
retain the existing REST behavior for compatibility. Billing links require the
user to complete Stripe's hosted flow.

Reuse the existing connection wizard with an account mode and the same secret
handling and client configurations. Account mode explains its broad access and
excluded credential operations. Connection history labels account tokens clearly.

MCP discovers ACCOUNT credentials and exposes the existing broad tools plus account
details, subscription, allowance, check moves, status-page management, invitation
inspection/acceptance, Telegram handshake tools, and billing links. Existing
credential catalogs stay compatible. No token-management or password tools exist.

Verify policy boundaries, authentication/expiry/revocation, creation and hash-only
storage, changing membership and roles, unrelated accounts, admin isolation,
billing service delegation, MCP catalogs and GraphQL variables, and the account
wizard. Run API lint/typecheck/unit/e2e and frontend lint/typecheck/unit checks,
plus MCP typecheck/tests/package smoke. Update contributor and user documentation.

## Approved follow-up: simplify account token controls

The user requested retiring the old agent-connections page. Token creation,
account-wide history and revocation now live directly in Account settings.
The legacy URL redirects to `/account#personal-access-tokens`; organization-scoped
creation buttons and the separate sidebar entry are removed. Existing credentials
retain their API permissions and can be revoked from Account. Claude setup names
are normalized to meet CLI restrictions. npm publication remains a release step.
