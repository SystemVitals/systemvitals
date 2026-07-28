BEGIN;

CREATE TABLE "check_channel_exclusions" (
    "check_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_channel_exclusions_pkey" PRIMARY KEY ("check_id","channel_id")
);

CREATE INDEX "check_channel_exclusions_channel_id_idx"
ON "check_channel_exclusions"("channel_id");

ALTER TABLE "check_channel_exclusions"
ADD CONSTRAINT "check_channel_exclusions_check_id_fkey"
FOREIGN KEY ("check_id") REFERENCES "checks"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_channel_exclusions"
ADD CONSTRAINT "check_channel_exclusions_channel_id_fkey"
FOREIGN KEY ("channel_id") REFERENCES "notification_channels"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
