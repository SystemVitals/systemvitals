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
