ALTER TABLE "users"
ADD COLUMN "checkout_in_flight_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "users"
ADD CONSTRAINT "users_checkout_in_flight_count_nonnegative"
CHECK ("checkout_in_flight_count" >= 0);
