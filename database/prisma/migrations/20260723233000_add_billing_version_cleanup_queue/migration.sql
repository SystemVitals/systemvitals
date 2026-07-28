ALTER TABLE "users"
ADD COLUMN "billing_state_version" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "checkout_cleanup_intents" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "stripe_session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "checkout_cleanup_intents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "checkout_cleanup_intents_stripe_session_id_key"
ON "checkout_cleanup_intents"("stripe_session_id");

CREATE INDEX "checkout_cleanup_intents_user_id_created_at_idx"
ON "checkout_cleanup_intents"("user_id", "created_at");

ALTER TABLE "checkout_cleanup_intents"
ADD CONSTRAINT "checkout_cleanup_intents_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "checkout_cleanup_intents" (
    "id",
    "user_id",
    "stripe_session_id",
    "created_at"
)
SELECT
    "id" || ':legacy-checkout-cleanup',
    "id",
    "checkout_cleanup_session_id",
    COALESCE("checkout_cleanup_created_at", CURRENT_TIMESTAMP)
FROM "users"
WHERE "checkout_cleanup_session_id" IS NOT NULL
ON CONFLICT ("stripe_session_id") DO NOTHING;

UPDATE "users"
SET
    "checkout_cleanup_session_id" = NULL,
    "checkout_cleanup_created_at" = NULL
WHERE "checkout_cleanup_session_id" IS NOT NULL
   OR "checkout_cleanup_created_at" IS NOT NULL;
