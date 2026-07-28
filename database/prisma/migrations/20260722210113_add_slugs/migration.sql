-- Slugs for organizations, projects and checks.
--
-- Added nullable, backfilled, then constrained — all inside the single
-- transaction Postgres gives a migration, so no row is ever visible without a
-- slug and a partial failure rolls the whole thing back.
--
-- The slugify expression below mirrors api/src/common/slug.ts with one
-- deliberate difference: it STRIPS diacritics rather than folding them, since
-- SQL cannot transliterate without the unaccent extension. All existing names
-- are ASCII, so this is lossless for the current data; every row created after
-- this migration is slugified by the TypeScript module instead.
--
-- De-dup assignment: each backfill block below walks its rows in
-- (created_at, id) order and assigns the first slug in the series
-- `base`, `base-2`, `base-3`, … that is not already ASSIGNED to another row
-- in the same uniqueness scope — mirroring uniqueSlug() in
-- api/src/common/slug.ts exactly (which checks each candidate against the
-- live taken set, including previously-generated suffixes). A plain
-- `row_number() OVER (PARTITION BY slug ...)` scheme is NOT equivalent: it
-- partitions by the natural (un-suffixed) slug only, so a generated
-- suffix like `base-2` is never checked against a different row whose
-- NATURAL slug already is `base-2` — that cross-partition collision makes
-- two rows land on the same final slug and aborts the migration's
-- `CREATE UNIQUE INDEX` below. Walking rows procedurally against a running
-- "taken" set closes that gap.
--
-- Length budget: the final slug (including any `-N` suffix) must stay
-- ≤ 60 chars and must never end in a hyphen. The loop below budgets room for
-- the suffix and trims the base into that room BEFORE appending it — the
-- same thing uniqueSlug() does — rather than truncating after appending,
-- which could silently produce an invalid >60-char slug.

ALTER TABLE "organizations" ADD COLUMN "slug" TEXT;
ALTER TABLE "projects"      ADD COLUMN "slug" TEXT;
ALTER TABLE "checks"        ADD COLUMN "slug" TEXT;

-- Organizations: globally unique. Also reserved-word checked — organization
-- slugs occupy the first URL segment, so a base slug that lands in the same
-- reserved set as api/src/common/slug.ts's RESERVED_ORG_SLUGS gets `-org`
-- appended BEFORE de-dup assignment runs (matching isReservedOrgSlug() +
-- AuthService.provisionUserWithRetry()'s `${base}-org` fallback), so the
-- assignment loop still guarantees uniqueness on top of it.
CREATE TEMP TABLE tmp_org_taken (slug TEXT PRIMARY KEY);

DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INT;
  room INT;
BEGIN
  FOR r IN
    WITH raw AS (
      SELECT id, created_at,
             COALESCE(
               NULLIF(
                 btrim(
                   left(btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-'), 60),
                   '-'
                 ),
                 ''
               ),
               'untitled'
             ) AS base_slug
      FROM organizations
    )
    SELECT id, created_at,
           CASE
             WHEN base_slug IN (
               'account', 'admin', 'auth', 'billing', 'channels', 'checks', 'dashboard',
               'escalation', 'login', 'signup', 'status', 'status-pages', 'api', 'ping',
               'settings', 'docs', 'help', 'new', 'org', 'orgs', 'team', 'teams', 'projects',
               'pricing', 'about', 'blog', 'terms', 'privacy', 'contact', 'support', '_next',
               'static', 'favicon.ico', 'robots.txt', 'sitemap.xml'
             ) THEN base_slug || '-org'
             ELSE base_slug
           END AS slug
    FROM raw
    ORDER BY created_at, id
  LOOP
    IF NOT EXISTS (SELECT 1 FROM tmp_org_taken WHERE slug = r.slug) THEN
      candidate := r.slug;
    ELSE
      n := 2;
      LOOP
        room := 60 - length('-' || n::text);
        candidate := btrim(left(r.slug, room), '-') || '-' || n::text;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM tmp_org_taken WHERE slug = candidate);
        n := n + 1;
      END LOOP;
    END IF;

    INSERT INTO tmp_org_taken (slug) VALUES (candidate);
    UPDATE organizations SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

DROP TABLE tmp_org_taken;

-- Projects: unique within an organization. Never reserved-word checked —
-- project slugs sit in a deeper URL segment.
CREATE TEMP TABLE tmp_proj_taken (organization_id TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (organization_id, slug));

DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INT;
  room INT;
BEGIN
  FOR r IN
    SELECT id, organization_id, created_at,
           COALESCE(
             NULLIF(
               btrim(
                 left(btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-'), 60),
                 '-'
               ),
               ''
             ),
             'untitled'
           ) AS slug
    FROM projects
    ORDER BY created_at, id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM tmp_proj_taken WHERE organization_id = r.organization_id AND slug = r.slug
    ) THEN
      candidate := r.slug;
    ELSE
      n := 2;
      LOOP
        room := 60 - length('-' || n::text);
        candidate := btrim(left(r.slug, room), '-') || '-' || n::text;
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM tmp_proj_taken WHERE organization_id = r.organization_id AND slug = candidate
        );
        n := n + 1;
      END LOOP;
    END IF;

    INSERT INTO tmp_proj_taken (organization_id, slug) VALUES (r.organization_id, candidate);
    UPDATE projects SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

DROP TABLE tmp_proj_taken;

-- Checks: unique within a project. Never reserved-word checked.
CREATE TEMP TABLE tmp_check_taken (project_id TEXT NOT NULL, slug TEXT NOT NULL, PRIMARY KEY (project_id, slug));

DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INT;
  room INT;
BEGIN
  FOR r IN
    SELECT id, project_id, created_at,
           COALESCE(
             NULLIF(
               btrim(
                 left(btrim(regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g'), '-'), 60),
                 '-'
               ),
               ''
             ),
             'untitled'
           ) AS slug
    FROM checks
    ORDER BY created_at, id
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM tmp_check_taken WHERE project_id = r.project_id AND slug = r.slug
    ) THEN
      candidate := r.slug;
    ELSE
      n := 2;
      LOOP
        room := 60 - length('-' || n::text);
        candidate := btrim(left(r.slug, room), '-') || '-' || n::text;
        EXIT WHEN NOT EXISTS (
          SELECT 1 FROM tmp_check_taken WHERE project_id = r.project_id AND slug = candidate
        );
        n := n + 1;
      END LOOP;
    END IF;

    INSERT INTO tmp_check_taken (project_id, slug) VALUES (r.project_id, candidate);
    UPDATE checks SET slug = candidate WHERE id = r.id;
  END LOOP;
END $$;

DROP TABLE tmp_check_taken;

ALTER TABLE "organizations" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "projects"      ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "checks"        ALTER COLUMN "slug" SET NOT NULL;

CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");
CREATE UNIQUE INDEX "checks_project_id_slug_key" ON "checks"("project_id", "slug");
