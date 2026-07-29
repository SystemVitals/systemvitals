import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const databaseDir = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseDir, "prisma", "migrations");
const targetMigration = "20260731120000_enforce_one_project_per_organization";
const migration = join(migrationsDir, targetMigration, "migration.sql");

function psqlUrl(url: URL): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}

function psql(url: URL, args: string[]): string {
  return execFileSync(
    "psql",
    [psqlUrl(url), "-v", "ON_ERROR_STOP=1", ...args],
    {
      cwd: databaseDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function withOldSchema(run: (url: URL) => void): void {
  const databaseName = `systemvitals_workspace_${randomUUID().replaceAll("-", "")}`;
  if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
    throw new Error(`Unsafe temporary database name: ${databaseName}`);
  }
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = "/postgres";
  adminUrl.search = "";
  const testUrl = new URL(sourceUrl);
  testUrl.pathname = `/${databaseName}`;
  testUrl.search = "";

  psql(adminUrl, ["-c", `CREATE DATABASE "${databaseName}"`]);
  try {
    for (const name of readdirSync(migrationsDir)
      .filter(
        (candidate) =>
          candidate < targetMigration && candidate !== "migration_lock.toml",
      )
      .sort()) {
      psql(testUrl, ["-f", join(migrationsDir, name, "migration.sql")]);
    }
    psql(testUrl, [
      "-c",
      `
        INSERT INTO users (id, email, password_hash, created_at, updated_at)
        VALUES ('workspace-user', 'workspace@example.com', 'x', now(), now());
      `,
    ]);
    run(testUrl);
  } finally {
    psql(adminUrl, [
      "-c",
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    ]);
  }
}

function insertOrganizations(url: URL, values: string): void {
  psql(url, [
    "-c",
    `
      INSERT INTO organizations (id, name, slug, creator_user_id)
      VALUES ${values};
    `,
  ]);
}

function insertProjects(url: URL, values: string): void {
  psql(url, [
    "-c",
    `
      INSERT INTO projects (id, name, slug, ping_key, organization_id)
      VALUES ${values};
    `,
  ]);
}

describe("one project per organization migration", () => {
  it("locks both cardinality tables before checking and has no data-writing statement", () => {
    const sql = readFileSync(migration, "utf8");
    const organizationsLock = sql.indexOf('LOCK TABLE "organizations"');
    const projectsLock = sql.indexOf('LOCK TABLE "projects"');
    const cardinalityQuery = sql.indexOf("HAVING COUNT(p.id) <> 1");
    const uniqueIndex = sql.indexOf(
      'CREATE UNIQUE INDEX "projects_organization_id_key"',
    );

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(organizationsLock).toBeGreaterThan(-1);
    expect(projectsLock).toBeGreaterThan(organizationsLock);
    expect(cardinalityQuery).toBeGreaterThan(projectsLock);
    expect(uniqueIndex).toBeGreaterThan(cardinalityQuery);
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|COPY)\b/i);
  });

  it("accepts valid data, rejects a second project, and preserves organization cascade deletion", () => {
    withOldSchema((url) => {
      insertOrganizations(
        url,
        "('org-one', 'One', 'one', 'workspace-user')",
      );
      insertProjects(
        url,
        "('project-one', 'Default', 'default', 'ping-one', 'org-one')",
      );

      psql(url, ["-f", migration]);

      expect(() =>
        insertProjects(
          url,
          "('project-two', 'Second', 'second', 'ping-two', 'org-one')",
        ),
      ).toThrow();
      psql(url, ["-c", "DELETE FROM organizations WHERE id = 'org-one'"]);
      expect(
        psql(url, [
          "-Atc",
          "SELECT count(*) FROM projects WHERE organization_id = 'org-one'",
        ]),
      ).toBe("0");
    });
  });

  it("reports every incompatible organization and rolls back rows and indexes", () => {
    withOldSchema((url) => {
      insertOrganizations(
        url,
        `
          ('org-zero', 'Zero', 'zero', 'workspace-user'),
          ('org-one', 'One', 'one', 'workspace-user'),
          ('org-two', 'Two', 'two', 'workspace-user')
        `,
      );
      insertProjects(
        url,
        `
          ('project-one', 'Default', 'default', 'ping-one', 'org-one'),
          ('project-two-a', 'Default', 'default', 'ping-two-a', 'org-two'),
          ('project-two-b', 'Second', 'second', 'ping-two-b', 'org-two')
        `,
      );
      const beforeRows = psql(url, [
        "-Atc",
        `
          SELECT json_agg(row_to_json(snapshot) ORDER BY snapshot.id)
          FROM (
            SELECT id, name, slug, ping_key, organization_id
            FROM projects
          ) snapshot
        `,
      ]);
      const beforeIndexes = psql(url, [
        "-Atc",
        `
          SELECT coalesce(json_agg(indexname ORDER BY indexname), '[]'::json)
          FROM pg_indexes WHERE tablename = 'projects'
        `,
      ]);

      const result = spawnSync(
        "psql",
        [psqlUrl(url), "-v", "ON_ERROR_STOP=1", "-f", migration],
        { cwd: databaseDir, encoding: "utf8" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        '[{"organizationId":"org-two","projectCount":2},{"organizationId":"org-zero","projectCount":0}]',
      );
      expect(
        psql(url, [
          "-Atc",
          `
            SELECT json_agg(row_to_json(snapshot) ORDER BY snapshot.id)
            FROM (
              SELECT id, name, slug, ping_key, organization_id
              FROM projects
            ) snapshot
          `,
        ]),
      ).toBe(beforeRows);
      expect(
        psql(url, [
          "-Atc",
          `
            SELECT coalesce(json_agg(indexname ORDER BY indexname), '[]'::json)
            FROM pg_indexes WHERE tablename = 'projects'
          `,
        ]),
      ).toBe(beforeIndexes);
    });
  });
});
