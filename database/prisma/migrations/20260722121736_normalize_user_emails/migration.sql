-- Normalizes User.email to lowercase at rest, matching the application-level
-- normalization in api/src/common/email.ts.
--
-- Rows whose canonical (lowercase) form is shared by more than one account are
-- deliberately LEFT ALONE rather than merged, dropped, or force-lowercased:
--   * lowercasing them would violate users_email_key,
--   * and the api service depends on this migration completing
--     (`condition: service_completed_successfully`), so aborting here would
--     stop the API from starting at all — turning a data-quality problem into
--     an outage.
-- Those accounts keep their original casing and stay duplicated until a human
-- merges them; the WARNING below is how that surfaces.
DO $$
DECLARE
  collisions INT;
  sample TEXT;
BEGIN
  SELECT count(*), min(canonical)
    INTO collisions, sample
  FROM (
    SELECT lower(email) AS canonical
    FROM users
    GROUP BY lower(email)
    HAVING count(*) > 1
  ) dupes;

  IF collisions > 0 THEN
    RAISE WARNING
      'users.email: left % address(es) un-normalised because more than one account resolves to each (e.g. %). Merge those accounts by hand — until then they keep their original casing and can still be duplicated by Google sign-in.',
      collisions, sample;
  END IF;
END $$;

UPDATE users
SET email = lower(email)
WHERE email <> lower(email)
  AND NOT EXISTS (
    SELECT 1
    FROM users other
    WHERE other.id <> users.id
      AND lower(other.email) = lower(users.email)
  );
