ALTER TABLE "api_tokens"
ADD COLUMN "project_name_snapshot" TEXT,
ADD COLUMN "organization_name_snapshot" TEXT;

UPDATE "api_tokens" AS token
SET
  "project_name_snapshot" = project."name",
  "organization_name_snapshot" = organization."name"
FROM "projects" AS project
JOIN "organizations" AS organization
  ON organization."id" = project."organization_id"
WHERE token."project_id" = project."id";

ALTER TABLE "api_tokens"
DROP CONSTRAINT "api_tokens_project_id_fkey";

ALTER TABLE "api_tokens"
ADD CONSTRAINT "api_tokens_project_id_fkey"
FOREIGN KEY ("project_id")
REFERENCES "projects"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
