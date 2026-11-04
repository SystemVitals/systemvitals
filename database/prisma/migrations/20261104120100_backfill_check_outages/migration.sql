BEGIN;

-- Rebuilds outage history from check_events. Status writers keep running
-- during the deploy: streaks that start at or after the cutoff belong to the
-- checks_record_outage trigger, and the long event scan runs before "checks"
-- is locked.

-- (a) Reconstruct DOWN streaks into a staging table without locking "checks".
-- The staging table has no foreign key, so the scan takes no row locks on
-- "checks", and one statement gives closed and unterminated streaks the same
-- snapshot. "ended_at" is NULL when no event follows the streak yet.
CREATE TEMP TABLE "backfill_streaks" (
    "check_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3)
) ON COMMIT DROP;

WITH events AS (
    SELECT
        e."id",
        e."check_id",
        e."timestamp",
        e."status",
        c."interval_seconds",
        c."type" IN ('HTTP', 'TCP', 'PING')
            AND c."interval_seconds" IS NOT NULL AS active,
        LAG(e."status") OVER w AS prev_status,
        LAG(e."timestamp") OVER w AS prev_at,
        LEAD(e."status") OVER w AS next_status,
        LEAD(e."timestamp") OVER w AS next_at
    FROM "check_events" e
    JOIN "checks" c ON c."id" = e."check_id"
    WINDOW w AS (PARTITION BY e."check_id" ORDER BY e."timestamp", e."id")
),
down_events AS (
    SELECT
        *,
        COALESCE(active AND "timestamp" - prev_at
            > GREATEST(3 * "interval_seconds", 300) * INTERVAL '1 second', FALSE)
            AS gap_before,
        COALESCE(active AND next_at - "timestamp"
            > GREATEST(3 * "interval_seconds", 300) * INTERVAL '1 second', FALSE)
            AS gap_after
    FROM events
    WHERE "status" = 'DOWN'
),
bounded AS (
    SELECT
        *,
        prev_status IS DISTINCT FROM 'DOWN' OR gap_before AS starts,
        next_status IS DISTINCT FROM 'DOWN' OR gap_after AS ends
    FROM down_events
),
numbered AS (
    SELECT
        *,
        SUM(starts::int) OVER (
            PARTITION BY "check_id" ORDER BY "timestamp", "id"
        ) AS streak
    FROM bounded
),
streaks AS (
    SELECT
        "check_id",
        MIN("timestamp") AS started_at,
        MAX(CASE
            WHEN gap_after THEN "timestamp" + "interval_seconds" * INTERVAL '1 second'
            ELSE next_at
        END) FILTER (WHERE ends) AS ended_at
    FROM numbered
    GROUP BY "check_id", streak
    HAVING MIN("timestamp") < (SELECT "cutoff" FROM "check_outage_backfill_cutoff")
)
INSERT INTO "backfill_streaks" ("check_id", "started_at", "ended_at")
SELECT "check_id", started_at, ended_at
FROM streaks;

-- (b) Block status writers for the short phases below. Writers lock their
-- check row FOR UPDATE and then wait for this table lock, so take the row locks
-- first, matching that row-then-table order. Otherwise the foreign key checks
-- of the inserts below could wait for such a writer while it waits for this
-- transaction: a deadlock.
SELECT "id" FROM "checks" ORDER BY "id" FOR KEY SHARE;

LOCK TABLE "checks" IN SHARE ROW EXCLUSIVE MODE;

-- (c) Insert the staged closed outages, skipping checks deleted during the
-- scan, then resolve unterminated streaks against live data.
INSERT INTO "check_outages" ("check_id", "started_at", "ended_at")
SELECT s."check_id", s."started_at", s."ended_at"
FROM "backfill_streaks" s
WHERE s."ended_at" IS NOT NULL
  AND EXISTS (SELECT 1 FROM "checks" c WHERE c."id" = s."check_id");

INSERT INTO "check_outages" ("check_id", "started_at", "ended_at")
SELECT u."check_id", u."started_at", COALESCE(recovery."timestamp", c."updated_at")
FROM "backfill_streaks" u
JOIN "checks" c ON c."id" = u."check_id"
LEFT JOIN LATERAL (
    SELECT e."timestamp"
    FROM "check_events" e
    WHERE e."check_id" = u."check_id"
      AND e."timestamp" > u."started_at"
      AND e."status" <> 'DOWN'
    ORDER BY e."timestamp", e."id"
    LIMIT 1
) recovery ON TRUE
WHERE u."ended_at" IS NULL
  AND (recovery."timestamp" IS NOT NULL OR c."status" <> 'DOWN');

INSERT INTO "check_outages" ("check_id", "started_at")
SELECT u."check_id", u."started_at"
FROM "backfill_streaks" u
JOIN "checks" c ON c."id" = u."check_id"
WHERE u."ended_at" IS NULL
  AND c."status" = 'DOWN'
  AND NOT EXISTS (
      SELECT 1
      FROM "check_events" e
      WHERE e."check_id" = u."check_id"
        AND e."timestamp" > u."started_at"
        AND e."status" <> 'DOWN'
  )
ON CONFLICT ("check_id") WHERE "ended_at" IS NULL DO NOTHING;

INSERT INTO "check_outages" ("check_id", "started_at")
SELECT c."id", COALESCE(c."last_event_at", c."updated_at")
FROM "checks" c
WHERE c."status" = 'DOWN'
  AND NOT EXISTS (
      SELECT 1
      FROM "check_outages" o
      WHERE o."check_id" = c."id" AND o."ended_at" IS NULL
  );

-- (d) Merge overlapping outages per check (gaps and islands). An island's rows
-- are deleted before its merged row is inserted, so the partial unique index
-- never sees two open outages for one check.
CREATE TEMP TABLE "backfill_islands" ON COMMIT DROP AS
WITH ordered AS (
    SELECT
        "id",
        "check_id",
        "started_at",
        "ended_at",
        COALESCE("started_at" > MAX(COALESCE("ended_at", 'infinity')) OVER (
            PARTITION BY "check_id" ORDER BY "started_at", "id"
            ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
        ), TRUE) AS starts
    FROM "check_outages"
),
numbered AS (
    SELECT
        *,
        SUM(starts::int) OVER (
            PARTITION BY "check_id" ORDER BY "started_at", "id"
        ) AS island
    FROM ordered
)
SELECT
    "check_id",
    array_agg("id") AS ids,
    MIN("started_at") AS started_at,
    CASE WHEN bool_or("ended_at" IS NULL) THEN NULL ELSE MAX("ended_at") END
        AS ended_at
FROM numbered
GROUP BY "check_id", island
HAVING COUNT(*) > 1;

DELETE FROM "check_outages" o
USING "backfill_islands" i
WHERE o."id" = ANY (i.ids);

INSERT INTO "check_outages" ("check_id", "started_at", "ended_at")
SELECT "check_id", started_at, ended_at
FROM "backfill_islands";

-- (e) The cutoff is only needed by this backfill.
DROP TABLE "check_outage_backfill_cutoff";

COMMIT;
