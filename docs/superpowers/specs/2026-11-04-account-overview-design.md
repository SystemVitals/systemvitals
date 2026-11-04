# Account Overview Design

**Date:** 2026-11-04
**Status:** Approved

## Summary

Add an account-wide **Overview** page that covers every organization the
signed-in user belongs to. It answers two questions at a glance:

1. **What needs fixing right now?** Every check that is broken at the moment,
   across all organizations, with how long it has been broken.
2. **How healthy is everything overall?** A summary of how long things were
   broken over a selected time range, with charts that show when, where, and
   which checks.

The existing `/dashboard` stays as it is: a per-organization list of checks
for the selected organization. The Overview is read-only and sits above it.

## Why

The user runs checks across several organizations and today must switch
organizations one at a time to see what is broken. They want one place to:

- see what needs fixing, and
- judge overall system health by **how long things are broken**: total broken
  time, outage lengths, and recovery time. A "days since the last incident"
  counter is not what they mean.

The approved mockup is in the brainstorming session's screenshots. This
document describes it in words, so the builder does not need the images.

## Goals

- One page showing all checks in all of the user's organizations, regardless
  of role.
- A "Needs fixing" list of currently broken checks, longest-broken first,
  showing each check's organization, type, a short reason, how long it has
  been broken, and its "how to fix" description when it has one.
- Summary numbers and charts for a selectable range (24h, 7d, 30d, 90d) based
  on the duration of outages.
- Works well on a phone, which is how the user will often check it.
- Fast: an account at its plan's check limit loads the page in well under a
  second, even with the 90d range.

## Non-Goals

- An MCP tool for the overview. The GraphQL query is reachable by account
  PATs, so a tool can follow later.
- Response-time or latency charts. These stay on the check page.
- Filtering the overview to a subset of organizations.
- SLA targets, uptime goals, or alerts based on the overview.
- Incident notes, acknowledgement, or postmortems.
- Recording pause history.
- Changing login redirects or the logo link. Both keep going to `/dashboard`.

## Anti-Goals

The page fails, even if it technically works, if it:

- Shows any organization, check, or outage the user is not a current member
  of. Leaving an organization must remove it from the overview immediately.
- Exposes creator identity or other members' data.
- Counts time a check spent paused as broken time.
- Feels slow or stale. A broken check must show up within the same polling
  interval the dashboard uses.

## Definitions

These terms appear on the page and in the API. They must match exactly.

- **Broken check.** A check whose current status is `DOWN`, or a **late**
  heartbeat.
- **Late heartbeat.** A `HEARTBEAT` check with status `UP` whose expected ping
  time has passed but whose grace period has not. "Expected ping time" is the
  value `Check.nextExpectedAt` already resolves: `lastEventAt + periodSeconds`,
  or the next cron fire after `lastEventAt`. The check is late whenever
  `nextExpectedAt < now`, with no upper bound, which matches how the check
  page already treats overdue heartbeats. While
  `now ≤ nextExpectedAt + graceSeconds`, the page says "late by …". Past that
  point, the watchdog simply hasn't marked it `DOWN` yet, for example because
  of its 30s sweep or because the worker is down. The check stays `LATE`, with
  `downAt` in the past, and the page says "overdue by …". That way an overdue
  heartbeat never drops off "Needs fixing" while the worker is down. *(My call,
  from the builder check.)* The `GRACE` status enum has no producer today, so
  lateness is computed, not stored. HTTP and TCP checks are never late.
- **Outage.** One continuous stretch during which a check's status was `DOWN`.
  It starts when the status becomes `DOWN`. It ends when the status changes to
  anything else: `UP` on recovery, `PAUSED` on pause, or `NEW` after a type
  conversion. An outage with no end is **ongoing**.
- **Broken time.** The sum of outage durations, each clipped to the selected
  range. Ongoing outages count up to now.
- **Late time** does not count as broken time. A late check is not yet `DOWN`.

## Data Model: Outage History

### Why a new table

Outages can't be reconstructed cheaply from `check_events`:

- HTTP and TCP checks write an event on every probe. Over 90 days that can
  reach millions of rows per account.
- Pause, resume, and type conversion write no event at all.

Instead, record outages as they happen.

### `CheckOutage` model (`check_outages`)

| Field | Type | Notes |
|---|---|---|
| `id` | `String @id @default(cuid())` | Matches the repo's existing cuid convention. |
| `checkId` | `String` → `checks.id` | `onDelete: Cascade`. |
| `startedAt` | `DateTime` | When the status became `DOWN`. |
| `endedAt` | `DateTime?` | When the status left `DOWN`. `null` means ongoing. |

Indexes:

- `(check_id, started_at)`
- A partial unique index on `(check_id) WHERE ended_at IS NULL`, so a check
  never has two ongoing outages.
- Something that serves "outages overlapping a range for a set of checks". The
  builder may decide this is covered by the first index.

Outages follow their check. Moving a check to another organization moves its
history with it, and deleting a check deletes its history.

### How rows are written: a database trigger

At least seven code paths write `checks.status`:

- worker: probe handler and heartbeat watchdog
- API: ping service, pause, resume, type conversion in `updateCheck`, and
  admin pause/resume

A Postgres trigger on `checks`, `AFTER INSERT OR UPDATE OF status`, keeps
outage history correct for every current and future writer:

- When the status changes to `DOWN` (from anything else, or on insert as
  `DOWN`), insert an outage with `started_at = now()`.
- When the status changes from `DOWN` to anything else, set `ended_at = now()`
  on the check's open outage.
- Updates that do not change the status do nothing. An HTTP check probed `DOWN`
  repeatedly still has one outage.

`now()` is the transaction timestamp. It may differ by milliseconds from the
Node-generated `CheckEvent.timestamp` in the same transaction, which is fine.

This is the repo's first trigger. It lives in a Prisma migration as raw SQL.
Add a short note to `database/README.md` so future contributors know status
writes have this side effect.

### Backfill

The migration that creates the table also builds outage history from the
existing `check_events`:

- An outage starts at each `DOWN` event whose previous event for the same check
  (by `timestamp`) is not `DOWN`, or which has no previous event.
- It ends at the timestamp of the first later non-`DOWN` event for that check.
- **Pause-gap rule (HTTP and TCP only).** Pausing writes no event. So an HTTP
  or TCP outage that was paused, resumed, and then recovered would otherwise
  count the whole paused stretch as broken time.
  - Within an outage, look at each pair of consecutive events.
  - If the gap is larger than `3 × intervalSeconds` (using the check's current
    interval; at least 5 minutes), treat the check as unmonitored during the
    gap.
  - End the outage at the earlier event's timestamp plus `intervalSeconds`.
  - If the event after the gap is still `DOWN`, start a new outage there.

  Heartbeats have no regular event cadence, so a pause while `DOWN` cannot be
  detected for them. That approximation is accepted.
- **Decided by the user:** rebuild history from existing data, so the 90-day
  view is populated at launch. Do not start empty.
- If no later non-`DOWN` event exists:
  - and the check's current status is `DOWN`: leave the outage open;
  - otherwise (paused, or converted since): close it at the check's
    `updated_at`. This approximation is accepted.
- Afterwards, the unique-open-outage invariant must hold. Every check that is
  currently `DOWN` must have exactly one open outage. If a `DOWN` check has no
  `DOWN` event, open one at `COALESCE(last_event_at, updated_at)`.

**Constraint:** status changes made by other transactions while the migration
runs must not be lost. Production deploys are zero-downtime, so the worker and
API keep writing during `prisma migrate deploy`. The builder chooses how, for
example by installing the trigger before the backfill and having the backfill
skip checks the trigger already handled, or by reconciling at the end. Do not
block pings for the length of the backfill.

## API

### New module: `overview`

Create `api/src/overview/` with a module, resolver, service, and `models/`,
following the per-domain pattern. Resolvers stay thin and the service holds the
logic.

### Query

```graphql
enum OverviewRange { DAY WEEK MONTH QUARTER }   # 24h, 7d, 30d, 90d

accountOverview(range: OverviewRange!, timeZone: String): AccountOverview!
```

- `timeZone` is an IANA name from the browser. It is used for day buckets.
  Invalid or missing values fall back to `UTC`.
- The range is `[now − range, now]`, computed on the server.

### Access

- **Sessions.** Allowed. The scope is every organization where the user has a
  `Membership`, any role. When an admin impersonates a user, it is the
  impersonated user's organizations, as with every other query today.
- **Account PATs** (`account:manage`). Allowed. Add `accountOverview` to
  `ACCOUNT_TOKEN_OPERATIONS` in `api/src/tokens/token-policy.ts`. The scope is
  the issuer's current memberships, matching how account PATs already delegate
  across memberships.
- **Scoped and legacy tokens.** Rejected. They are bound to one workspace, and
  an account-wide view does not fit them.
- Organization membership is checked at query time. No caching that could
  outlive a membership change.

### Response shape

```graphql
type AccountOverview {
  rangeStart: DateTime!
  rangeEnd: DateTime!
  organizationCount: Int!
  checkCount: Int!                 # all checks in scope, including paused
  needsFixing: [BrokenCheck!]!     # sorted, see below
  summary: OverviewSummary!
  buckets: [BrokenTimeBucket!]!    # chronological, empty ones included
  byOrganization: [OrganizationBrokenTime!]!   # every org in scope, broken time desc
  checks: [CheckBrokenTime!]!      # checks with ≥1 outage overlapping range, broken time desc
}

type BrokenCheck {
  check: CheckModel!               # existing type; organization slug/name must be reachable
  state: BrokenState!              # DOWN | LATE
  since: DateTime!                 # DOWN: open outage startedAt; LATE: nextExpectedAt
  downAt: DateTime                 # LATE only: nextExpectedAt + grace
  reason: String                   # see "Reason" below
}

type OverviewSummary {
  uptimePercent: Float             # null when there is no monitored time
  brokenSeconds: Int!
  outageCount: Int!                # outages overlapping range
  ongoingCount: Int!
  medianOutageSeconds: Int         # null when outageCount = 0
  longestOutage: CheckBrokenTime   # the check holding the longest single outage
}

type BrokenTimeBucket { start: DateTime!  brokenSeconds: Int! }

type OrganizationBrokenTime {
  organization: Organization!      # id, name, slug only
  brokenSeconds: Int!
  outageCount: Int!
}

type CheckBrokenTime {
  check: CheckModel!
  brokenSeconds: Int!
  outageCount: Int!
  longestOutageSeconds: Int!
  ongoing: Boolean!
  uptimePercent: Float
  outages: [OutageSpan!]!          # clipped to range, for the timeline
}

type OutageSpan { startedAt: DateTime!  endedAt: DateTime }   # endedAt null = ongoing
```

The builder may rename fields or restructure these types, as long as the page
can be built from one query. Reuse the existing `CheckModel` and organization
types where possible. The existing `CheckModel` resolve fields, such as
`events` and `nextExpectedAt`, must keep working on nested checks.

### Rules

- **Needs-fixing order.** All `DOWN` checks first, longest-broken first (oldest
  `since`). Then `LATE` checks, most overdue first (also oldest `since`).
  `PAUSED` and `NEW` checks never appear. *(Ordering of late checks is my
  call.)*
- **Reason.** A short human string for the row's subtitle:
  - `DOWN` heartbeat: "no ping since {lastEventAt}"
  - `DOWN` HTTP or TCP: the latest `DOWN` event's status code or error
  - `LATE`: the frontend builds the "goes DOWN in …" text from `downAt`

  Builder's call where exactly this is composed.
- **Description.** The check's existing `description` field is the "How to
  fix" note. It is shown verbatim and truncated to two lines in the list.
  `agentInstructions` is not shown.
- **Buckets.** Hourly for `DAY`, daily in `timeZone` for the other ranges.
  Each bucket's `brokenSeconds` is total outage time clipped to the bucket,
  summed across checks. A bucket can exceed its own length when several checks
  are down at once.
- **Uptime.** `1 − brokenSeconds / monitoredSeconds`, where a check's
  monitored time is the overlap of the range with `[check.createdAt, now]`.
  - Checks that are currently `PAUSED` are excluded from both terms, and so
    are checks that have never reported (`NEW` with no `lastEventAt`).
  - Pause history is not recorded, so a check paused and resumed inside the
    range counts its paused stretch as monitored and up. This is an accepted
    approximation.
  - Per-check `uptimePercent` uses the same formula.
- **Median and longest** use each outage's duration clipped to the range,
  including ongoing outages up to now.
- **Size.** Return all `checks` with outages. The frontend caps what it shows.
  Plan limits keep this list small.

### Performance

Load the user's memberships, then their checks, then outages where
`started_at < rangeEnd AND (ended_at IS NULL OR ended_at > rangeStart)` for
those check IDs. Aggregate in TypeScript. Avoid N+1 queries for nested
organization data, for example by loading organizations once and attaching
them. Never scan `check_events` for this query, except for the one
latest-`DOWN`-event lookup per currently broken HTTP or TCP check.

## Frontend

### Route and navigation

- New client page: `frontend/app/(app)/overview/page.tsx`.
  - It is a client component because the JWT lives in localStorage and every
    authenticated page in this app fetches with Apollo on the client.
  - It polls with `usePollWhenVisible` at `CHECK_POLL_INTERVAL_MS`, like the
    dashboard.
- Sidebar: add a new first section in `APP_NAV_SECTIONS` with one item,
  "Overview" (`LayoutGrid` or a similar lucide icon), linking to `/overview`.
  - Label the section "All organizations", so it doesn't clash with the
    existing "Account" page under "Personal".
  - No "NEW" badge.
- The Overview ignores the organization switcher. It always covers every
  organization.

### Page layout (top to bottom, from the approved mockup)

1. **Header.** Title "Overview". Subtitle "All your organizations · N
   organizations · M checks". On the right is a segmented range control: 24h /
   7d / 30d / 90d, default 30d, stored in the URL as `?range=`. On phone, the
   control spans the full width under the title.
2. **Needs fixing card** with a destructive-tinted border and a count badge.
   Each row has:
   - a status pill (DOWN in destructive, LATE in warning)
   - the check name, linking to the existing check page `/{orgSlug}/{checkSlug}`
   - a meta line: organization name in bold · check type · reason
   - a large right-aligned duration with a caption ("down for 3h 12m", "late by
     6m", or "overdue by 2m" once past grace), ticking at least once a minute
     on the client
   - the "How to fix:" note from `description`, when present, in a muted box

   **Empty state:** a success-toned "Nothing needs fixing" line. The card stays
   visible so its absence is never ambiguous.
3. **Section label** "Last {range}, all organizations". Under it, five stat
   tiles:
   - **Uptime**, with "across N checks"
   - **Time broken**, with "summed over all checks"
   - **Outages**, with "K still ongoing" in destructive when K > 0
   - **Typical fix time**, with "median outage length"
   - **Longest outage**, with the check name, plus ", ongoing" in destructive
     when it is still ongoing

   On phone, Uptime spans the full width and the other four form a 2×2 grid.
4. **Two charts side by side on desktop, stacked on phone:**
   - **Time broken per day** (per hour for 24h): a single-series bar chart.
     The y axis is hours, or minutes when the maximum is small. Bars use the
     destructive token, with a hover tooltip showing the bucket and its exact
     duration.
   - **Time broken by organization**: horizontal bars with the organization
     name above each bar and the duration label at the bar's end. Organizations
     with zero broken time are listed with an empty track and "0m".
5. **Outages timeline** (full width). It covers the selected range, so its
   title follows the range. This is a change from the mockup, which fixed the
   timeline at 7 days.
   - One row per check with outages, using the same order as `checks`, capped
     at 10 rows with "and N more" below.
   - Each row shows the check name and organization on the left and a muted
     track on the right.
   - Each outage is a destructive segment with a minimum visible width.
   - A currently late heartbeat gets a small warning-colored marker at "now".
   - A dashed "now" line marks the right edge.
   - Hovering a segment shows start, end or "ongoing", and duration.
   - A legend shows Down and Late.
6. **"Checks broken the longest" table**, top 10 from `checks`, with columns
   Check, Organization, Outages, Time broken, Longest (with an "ONGOING" tag),
   and Uptime. On phone, only Check, Time broken, and Uptime remain. Rows link
   to the check page.

**Empty states:**

- No organizations: prompt to create one.
- No checks: point to `/dashboard` to add one.
- No outages in range: the charts and table are replaced by one calm "No
  outages in the last {range}" line, and the stat tiles still show 100%.
- Loading: skeletons, as on the dashboard.
- Errors: the shadcn Dialog error pattern from the global conventions.

### Charts

- Use `recharts`, already a dependency and used by `ResponseTimeChart`, where
  it fits. The timeline may be custom SVG.
- Follow the repo's tokens (`--destructive`, `--warning`, `--muted`, …) and
  support the existing `.dark` theme.
- Down and Late are status colors. Never use them for anything else, and
  always pair them with a text label.
- Durations everywhere use one formatter: `1d 6h`, `3h 12m`, `18m`, `45s`.
  Extend `frontend/lib/format.ts` if `formatSpan` does not already produce
  this.

## Testing

- **database:**
  - The trigger opens and closes outages correctly for each transition, and
    ignores no-op status writes.
  - The unique-open-outage invariant holds.
  - The backfill produces the expected outages from a seeded event history.
    Cover these cases:
    - flapping
    - a heartbeat that went `DOWN` then `UP`
    - an HTTP check paused while `DOWN`, then resumed and recovered (the
      pause-gap rule splits or ends the outage)
    - an HTTP check still `DOWN` across a probe gap
    - a check still paused while `DOWN` (closed at `updated_at`)
    - a check currently `DOWN`
    - a `DOWN` check with no `DOWN` event
- **api:**
  - Unit tests for the overview aggregation: clipping at range edges, ongoing
    outages, buckets across a DST change in a non-UTC zone, median and longest,
    uptime exclusions, and late detection for period and cron heartbeats.
  - Resolver access: membership scoping, a removed member losing visibility,
    account PAT allowed, scoped token rejected.
  - One e2e test through GraphQL.
- **worker:** no logic changes are expected. The existing tests must still
  pass against a database with the trigger installed.
- **frontend:**
  - A page test covering needs-fixing ordering and rendering, the empty
    states, and the range control updating the URL and query.
  - A sidebar test update for the new section.

## Documentation

- `AGENTS.md`: one short paragraph on the account overview and its access
  rules, alongside the existing access notes.
- `docs/ARCHITECTURE.md`: outage history (table, trigger, backfill) and the
  overview query.
- `database/README.md`: the trigger and its side effect on status writes.
- `api/README.md`: the new query, if the API reference lives there.
- `frontend/README.md`: the new route.

## Left to the Builder

- Exact GraphQL field names and type nesting, within the constraints above.
- How the migration avoids losing concurrent transitions.
- Where the "reason" string is composed.
- Chart internals, tooltip styling, and whether the timeline uses recharts or
  custom SVG.
- Whether the service aggregates in one pass or several, given the performance
  constraint.
- How many PRs. One focused PR is fine. Splitting into outage history first,
  then overview API and page, is also fine.
