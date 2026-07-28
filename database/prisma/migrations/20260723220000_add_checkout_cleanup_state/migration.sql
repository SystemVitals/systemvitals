ALTER TABLE "users"
ADD COLUMN "checkout_cleanup_session_id" TEXT,
ADD COLUMN "checkout_cleanup_created_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "users_checkout_cleanup_session_id_key"
ON "users"("checkout_cleanup_session_id");
