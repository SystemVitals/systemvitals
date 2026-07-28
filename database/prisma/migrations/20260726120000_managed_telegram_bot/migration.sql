ALTER TABLE "notification_channels"
ADD COLUMN "destination_key" TEXT;

CREATE TABLE "telegram_connection_challenges" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "telegram_update_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "chat_type" TEXT NOT NULL,
    "chat_title" TEXT,
    "message_thread_id" INTEGER,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "telegram_connection_challenges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "telegram_connection_challenges_token_hash_key"
ON "telegram_connection_challenges"("token_hash");

CREATE UNIQUE INDEX "telegram_connection_challenges_telegram_update_id_key"
ON "telegram_connection_challenges"("telegram_update_id");

CREATE INDEX "telegram_connection_challenges_chat_id_message_thread_id_created_at_idx"
ON "telegram_connection_challenges"("chat_id", "message_thread_id", "created_at");

CREATE INDEX "telegram_connection_challenges_expires_at_idx"
ON "telegram_connection_challenges"("expires_at");

CREATE UNIQUE INDEX "notification_channels_project_id_type_destination_key_key"
ON "notification_channels"("project_id", "type", "destination_key");
