BEGIN;

CREATE TABLE "check_outages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "check_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),

    CONSTRAINT "check_outages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "check_outages_check_id_started_at_idx"
ON "check_outages"("check_id", "started_at");

CREATE UNIQUE INDEX "check_outages_one_open_per_check"
ON "check_outages"("check_id") WHERE "ended_at" IS NULL;

ALTER TABLE "check_outages"
ADD CONSTRAINT "check_outages_check_id_fkey"
FOREIGN KEY ("check_id") REFERENCES "checks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Consumed and dropped by the outage backfill migration.
CREATE TABLE "check_outage_backfill_cutoff" (
    "cutoff" TIMESTAMP(3) NOT NULL
);

-- clock_timestamp(), not now(): writers BEGIN before taking the check row lock,
-- so transaction start times can disagree with the order of status writes.
CREATE FUNCTION record_check_outage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'DOWN' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'DOWN') THEN
    INSERT INTO "check_outages" ("check_id", "started_at")
    VALUES (NEW."id", clock_timestamp() AT TIME ZONE 'UTC')
    ON CONFLICT ("check_id") WHERE "ended_at" IS NULL DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'DOWN' AND NEW.status <> 'DOWN' THEN
    UPDATE "check_outages" SET "ended_at" = clock_timestamp() AT TIME ZONE 'UTC'
    WHERE "check_id" = NEW."id" AND "ended_at" IS NULL;
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER checks_record_outage
  AFTER INSERT OR UPDATE OF status ON "checks"
  FOR EACH ROW EXECUTE FUNCTION record_check_outage();

-- After the trigger exists: CREATE TRIGGER waits for in-flight status writers,
-- so every transition committed before this cutoff predates the trigger.
INSERT INTO "check_outage_backfill_cutoff" ("cutoff")
VALUES (clock_timestamp() AT TIME ZONE 'UTC');

COMMIT;
