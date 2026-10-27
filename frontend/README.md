# SystemVitals Frontend

Next.js App-Router UI; a pure API client of the SystemVitals api.

## Development

```bash
npm run dev   # starts on port 9999
```

## Environment Variables

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the SystemVitals API (default: `http://localhost:8888`) |

Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_API_URL` to point at the api.

## Agent credentials

Account > Personal access tokens creates and revokes account-wide personal access
tokens. The shared token wizard uses a GraphQL mutation with Apollo's
`no-cache` policy, displays the secret once in a numbered copy → connect → try
result, and protects uncopied results on navigation ("Close without saving the
token?" — the token stays active). Account-token MCP setups name the server
`systemvitals`. If creation has an unknown outcome, reviewing connections explicitly
refreshes history so a potentially active token can be revoked.

Account tokens manage product resources across current organization permissions
and obtain hosted billing links. Password and token administration stay with the
login session. The organization Connect agent buttons and separate navigation entry are
retired; the old URL redirects to `/account#personal-access-tokens`. Existing
scoped credentials remain available in account-wide history for revocation. Deploy API support and publish the updated MCP package before rolling out
the account wizard's `npx` setup; source-checkout MCP and GraphQL access work without
package publication.

## App shell and UI conventions

- The sidebar always names the current organization ("Workspace") and groups
  navigation by scope: Monitoring (dashboard, channels, status pages),
  Organization (members, organizations), and Personal (billing, account). The
  mobile drawer reuses the same sections and organization switcher.
- Signed-in pages start with `components/app/page-header.tsx` and rely on the
  layout's padding rather than adding their own.
- Check statuses render as plain-language labels (`Up`, `Down`, `Late` for
  `GRACE`, `Waiting` for `NEW`, `Paused`) via `components/status-badge.tsx`.
- `lib/format.ts` provides `formatSpan` (exact durations such as "1 min 30 sec")
  and `formatRelativeTime` ("5 minutes ago", "in 30 days"); pair relative times
  with an absolute `title`.
- The dashboard sorts checks by severity (down, late, waiting, up, paused),
  offers status filters, and adds search at six or more checks. Check pages
  provide pause/resume and a confirmed delete.
- Destructive actions (deleting a check, removing a member, revoking a token)
  always confirm in a shadcn Dialog.

## Error monitoring

Sentry project: `nexus/systemvitals-frontend` at https://sentry.nihey.org. Set
`SENTRY_DSN` and `SENTRY_ENVIRONMENT` in the deployment environment. A blank
DSN disables monitoring; tests never send events. Error events omit request
data, user identity, and breadcrumbs. Tracing and SDK logs are disabled.
Set `NEXT_PUBLIC_SENTRY_DSN` at build time for browser errors. Optional source
map uploads require a build-only `SENTRY_SELF_HOSTED_AUTH_TOKEN`, `SENTRY_URL`,
`SENTRY_ORG`, and `SENTRY_PROJECT`; never expose the token publicly.

Source-map uploads use a dedicated self-hosted `SENTRY_SELF_HOSTED_AUTH_TOKEN` supplied only to the build process. Never add it to runtime environments, Docker build arguments or image ENV; Docker uploads require a BuildKit secret mount or a separate CI upload step.

Local build-only handoff: `/home/nihey/devel/nihey/.state/sentry/build-env/nexus-systemvitals-frontend.env` (outside Docker build contexts; mode 0600). Export it only for the build/upload command. Runtime DSN overlays contain no upload token.
