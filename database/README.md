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
`clock_timestamp() AT TIME ZONE 'UTC'`. It uses `clock_timestamp()` rather than
`now()` because `now()` is the transaction start time: writers begin before they
lock the check row, so racing writers could otherwise record `ended_at` before
`started_at`. Besides `(check_id, started_at)`, outages are indexed on
`(check_id, ended_at)`, which serves the account overview's "outages
overlapping a range" query. Release notes for these migrations, including the
backfill's write pause and recovery, are in `docs/DEPLOYMENT.md`.

Run database validation from this directory with a configured local
`DATABASE_URL`:

```bash
npm run generate
npx prisma validate
npm test
```
