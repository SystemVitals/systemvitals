ALTER TABLE "checkout_operations"
ADD COLUMN "operation_kind" TEXT NOT NULL DEFAULT 'CHECKOUT',
ADD COLUMN "stripe_customer_id" TEXT,
ADD COLUMN "portal_return_url" TEXT,
ALTER COLUMN "attempt_id" DROP NOT NULL,
ALTER COLUMN "requested_plan" DROP NOT NULL,
ALTER COLUMN "interval" DROP NOT NULL;

ALTER TABLE "checkout_operations"
ADD CONSTRAINT "checkout_operations_kind_check"
CHECK ("operation_kind" IN ('CHECKOUT', 'PORTAL'));
