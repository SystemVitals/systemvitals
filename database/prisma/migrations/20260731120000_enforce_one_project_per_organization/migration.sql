BEGIN;

LOCK TABLE "organizations" IN SHARE MODE;
LOCK TABLE "projects" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
    incompatible_workspaces TEXT;
BEGIN
    SELECT
        '[' ||
        string_agg(
            format(
                '{"organizationId":%s,"projectCount":%s}',
                to_json(organization_id)::text,
                project_count
            ),
            ',' ORDER BY organization_id
        ) ||
        ']'
    INTO incompatible_workspaces
    FROM (
        SELECT
            o.id AS organization_id,
            COUNT(p.id)::int AS project_count
        FROM organizations o
        LEFT JOIN projects p ON p.organization_id = o.id
        GROUP BY o.id
        HAVING COUNT(p.id) <> 1
        ORDER BY o.id
    ) incompatible;

    IF incompatible_workspaces IS NOT NULL THEN
        RAISE EXCEPTION
            'Organizations must each have exactly one project. Incompatible organizations: %',
            incompatible_workspaces;
    END IF;
END
$$;

CREATE UNIQUE INDEX "projects_organization_id_key"
ON "projects"("organization_id");

COMMIT;
