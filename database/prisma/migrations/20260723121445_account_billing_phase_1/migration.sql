-- Abort before making any phase-1 change when creator inference is impossible.
-- This standalone preflight lets Prisma report the actionable IDs directly.
DO $$
DECLARE
    ownerless_ids TEXT;
BEGIN
    SELECT string_agg(organization."id", ', ' ORDER BY organization."id")
    INTO ownerless_ids
    FROM "organizations" AS organization
    WHERE NOT EXISTS (
        SELECT 1
        FROM "memberships" AS membership
        WHERE membership."organization_id" = organization."id"
          AND membership."role" = 'OWNER'::"Role"
    );

    IF ownerless_ids IS NOT NULL THEN
        RAISE EXCEPTION
            'account billing phase 1 blocked: ownerless organization IDs: %',
            ownerless_ids;
    END IF;
END
$$;

BEGIN;

-- Phase 1 keeps organization billing columns and relations operational while
-- account-level ownership becomes authoritative.
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" TEXT;
ALTER TABLE "organizations" ADD COLUMN "creator_user_id" TEXT;
ALTER TABLE "subscriptions" ADD COLUMN "user_id" TEXT;
ALTER TABLE "subscriptions" ALTER COLUMN "organization_id" DROP NOT NULL;

-- A winning account subscription may retain its legacy organization during
-- transition, but deleting that organization must preserve account billing.
ALTER TABLE "subscriptions"
    DROP CONSTRAINT "subscriptions_organization_id_fkey";
ALTER TABLE "subscriptions"
    ADD CONSTRAINT "subscriptions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- The creator is the first OWNER membership, with id as a stable tie-breaker.
WITH ranked_owners AS (
    SELECT
        "organization_id",
        "user_id",
        ROW_NUMBER() OVER (
            PARTITION BY "organization_id"
            ORDER BY "created_at" ASC, "id" ASC
        ) AS owner_rank
    FROM "memberships"
    WHERE "role" = 'OWNER'::"Role"
)
UPDATE "organizations" AS organization
SET "creator_user_id" = ranked_owners."user_id"
FROM ranked_owners
WHERE ranked_owners."organization_id" = organization."id"
  AND ranked_owners.owner_rank = 1;

-- One subscription wins per creator. A higher plan wins first, then a row
-- backed by a live Stripe subscription, then deterministic creation/id order.
WITH ranked_subscriptions AS (
    SELECT
        subscription."id",
        organization."creator_user_id",
        ROW_NUMBER() OVER (
            PARTITION BY organization."creator_user_id"
            ORDER BY
                CASE subscription."plan"
                    WHEN 'FLEET'::"PlanTier" THEN 3
                    WHEN 'SIGNAL'::"PlanTier" THEN 2
                    WHEN 'SOLO'::"PlanTier" THEN 1
                END DESC,
                (
                    subscription."stripe_subscription_id" IS NOT NULL
                    AND subscription."status" NOT IN (
                        'canceled',
                        'incomplete_expired'
                    )
                ) DESC,
                subscription."created_at" ASC,
                subscription."id" ASC
        ) AS subscription_rank
    FROM "subscriptions" AS subscription
    JOIN "organizations" AS organization
      ON organization."id" = subscription."organization_id"
    WHERE subscription."status" IN ('active', 'trialing', 'past_due')
)
UPDATE "subscriptions" AS subscription
SET "user_id" = ranked_subscriptions."creator_user_id"
FROM ranked_subscriptions
WHERE ranked_subscriptions."id" = subscription."id"
  AND ranked_subscriptions.subscription_rank = 1;

-- The winning subscription's legacy organization supplies the account's
-- Stripe customer id. Winners intentionally retain organization_id.
UPDATE "users" AS account
SET "stripe_customer_id" = organization."stripe_customer_id"
FROM "subscriptions" AS subscription
JOIN "organizations" AS organization
  ON organization."id" = subscription."organization_id"
WHERE subscription."user_id" = account."id";

-- Every account gets exactly one subscription. The generated id is stable for
-- this backfill and does not require application code or an external service.
INSERT INTO "subscriptions" (
    "id",
    "organization_id",
    "user_id",
    "plan",
    "status",
    "manual_override",
    "created_at"
)
SELECT
    'account_subscription_' || md5(account."id"),
    NULL,
    account."id",
    'SOLO'::"PlanTier",
    'active',
    false,
    account."created_at"
FROM "users" AS account
WHERE NOT EXISTS (
    SELECT 1
    FROM "subscriptions" AS subscription
    WHERE subscription."user_id" = account."id"
);

ALTER TABLE "organizations" ALTER COLUMN "creator_user_id" SET NOT NULL;

CREATE UNIQUE INDEX "users_stripe_customer_id_key"
    ON "users"("stripe_customer_id");
CREATE INDEX "organizations_creator_user_id_idx"
    ON "organizations"("creator_user_id");
CREATE UNIQUE INDEX "subscriptions_user_id_key"
    ON "subscriptions"("user_id");

ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_creator_user_id_fkey"
    FOREIGN KEY ("creator_user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscriptions"
    ADD CONSTRAINT "subscriptions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
