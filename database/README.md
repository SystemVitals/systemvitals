# SystemVitals database

Notification routing uses project-owned `NotificationChannel` records and
per-check `CheckChannelExclusion` opt-outs. Every enabled channel in a check's
project is selected unless its `(checkId, channelId)` pair exists in
`check_channel_exclusions`.

The `20260728160000_check_channel_exclusions` migration introduced the exclusion
table empty, with no backfill. Exclusions cascade when either their check or
notification channel is deleted.

Run database validation from this directory with a configured local
`DATABASE_URL`:

```bash
npm run generate
npx prisma validate
npm test
```
