# SystemVitals database

The `CheckChannelExclusion` model stores notification-channel opt-outs for
individual checks. An enabled channel is selected for a check by default unless
the `(checkId, channelId)` pair exists in `check_channel_exclusions`.

The exclusion table is introduced empty, with no backfill, so existing checks
continue to select all enabled channels in their project. Exclusions are deleted
automatically when either their check or notification channel is deleted.

Run database validation from this directory with a configured local
`DATABASE_URL`:

```bash
npm run generate
npx prisma validate
npm test -- check-channel-exclusions-migration.test.ts check-channel-exclusions.test.ts
```
