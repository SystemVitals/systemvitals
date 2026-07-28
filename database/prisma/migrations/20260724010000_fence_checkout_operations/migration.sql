ALTER TABLE "checkout_operations"
ADD COLUMN "owner_token" UUID,
ADD COLUMN "state" TEXT,
ADD COLUMN "stripe_price_id" TEXT,
ADD COLUMN "success_url" TEXT,
ADD COLUMN "cancel_url" TEXT;

UPDATE "checkout_operations"
SET
    "owner_token" = gen_random_uuid(),
    "state" = 'UNCERTAIN'
WHERE "owner_token" IS NULL OR "state" IS NULL;

ALTER TABLE "checkout_operations"
ALTER COLUMN "owner_token" SET NOT NULL,
ALTER COLUMN "owner_token" SET DEFAULT gen_random_uuid(),
ALTER COLUMN "state" SET NOT NULL,
ALTER COLUMN "state" SET DEFAULT 'ACTIVE';
