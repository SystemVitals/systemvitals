-- AlterTable
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL,
ADD COLUMN "google_id" TEXT UNIQUE;
