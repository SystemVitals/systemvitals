CREATE TABLE "checkout_operations" (
    "id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "attempt_id" TEXT NOT NULL,
    "requested_plan" "PlanTier" NOT NULL,
    "interval" TEXT NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_operations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "checkout_operations_user_id_lease_expires_at_idx"
ON "checkout_operations"("user_id", "lease_expires_at");

ALTER TABLE "checkout_operations"
ADD CONSTRAINT "checkout_operations_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- checkout_in_flight_count was introduced on the same unreleased branch.
-- Leased rows above are the durable ownership source; old counters cannot be
-- backfilled because they carry no operation identity.
UPDATE "users" SET "checkout_in_flight_count" = 0
WHERE "checkout_in_flight_count" <> 0;
