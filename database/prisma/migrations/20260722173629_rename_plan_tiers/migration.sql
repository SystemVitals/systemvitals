-- Rename PlanTier enum values in place. Renaming a value preserves the type
-- OID, so every existing subscriptions.plan row and the column default
-- survive untouched. No backfill required.
ALTER TYPE "PlanTier" RENAME VALUE 'FREE' TO 'SOLO';
ALTER TYPE "PlanTier" RENAME VALUE 'PRO' TO 'SIGNAL';
ALTER TYPE "PlanTier" RENAME VALUE 'TEAM' TO 'FLEET';
