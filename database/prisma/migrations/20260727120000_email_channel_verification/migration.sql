-- Keep the ALTER TABLE lock until old API inserts can receive this default.
BEGIN;

ALTER TABLE "notification_channels"
ADD COLUMN "verified_at" TIMESTAMP(3),
ADD COLUMN "verification_token_hash" TEXT,
ADD COLUMN "verification_expires_at" TIMESTAMP(3),
ADD COLUMN "verification_sent_at" TIMESTAMP(3);

ALTER TABLE "notification_channels"
ALTER COLUMN "verified_at" SET DEFAULT CURRENT_TIMESTAMP;

UPDATE "notification_channels"
SET "verified_at" = CURRENT_TIMESTAMP
WHERE "type" = 'EMAIL' AND "verified_at" IS NULL;

CREATE UNIQUE INDEX "notification_channels_verification_token_hash_key"
ON "notification_channels"("verification_token_hash");

COMMIT;
