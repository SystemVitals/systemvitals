# SystemVitals database

Notification routing uses project-owned `NotificationChannel` records and
per-check `CheckChannelExclusion` opt-outs. Every enabled channel in a check's
project is selected unless its `(checkId, channelId)` pair exists in
`check_channel_exclusions`.

The `20260728160000_check_channel_exclusions` migration introduced the exclusion
table empty, with no backfill. Exclusions cascade when either their check or
notification channel is deleted.

## Outage history

Writes to `checks.status` open and close `check_outages` rows through the
`checks_record_outage` trigger (`record_check_outage()`); application code never
writes outages. A partial unique index, `check_outages_one_open_per_check`,
allows at most one open outage (`ended_at IS NULL`) per check. Outage timestamps
are `TIMESTAMP(3)` UTC like every other column, so the trigger uses
`now() AT TIME ZONE 'UTC'`, never bare `now()`.

Run database validation from this directory with a configured local
`DATABASE_URL`:

```bash
npm run generate
npx prisma validate
npm test
```
