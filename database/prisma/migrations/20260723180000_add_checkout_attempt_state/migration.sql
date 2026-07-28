ALTER TABLE "users"
    ADD COLUMN "checkout_attempt_id" TEXT,
    ADD COLUMN "checkout_attempt_plan" "PlanTier",
    ADD COLUMN "checkout_attempt_interval" TEXT,
    ADD COLUMN "checkout_attempt_created_at" TIMESTAMP(3),
    ADD COLUMN "checkout_session_id" TEXT,
    ADD COLUMN "checkout_session_url" TEXT,
    ADD COLUMN "checkout_session_expires_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_checkout_attempt_id_key"
    ON "users"("checkout_attempt_id");
CREATE UNIQUE INDEX "users_checkout_session_id_key"
    ON "users"("checkout_session_id");
