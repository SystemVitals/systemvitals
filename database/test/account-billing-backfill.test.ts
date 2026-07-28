import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const databaseDir = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseDir, "prisma", "migrations");
const phaseMigration = "20260723121445_account_billing_phase_1";

function checkedDatabaseName(label: string): string {
  const name = `systemvitals_${label}_${randomUUID().replaceAll("-", "")}`;
  if (!/^[a-z][a-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe temporary database name: ${name}`);
  }
  return name;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]+$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

function databaseUrl(databaseName: string): string {
  const url = new URL(DATABASE_URL);
  url.pathname = `/${databaseName}`;
  url.searchParams.set("schema", "public");
  return url.toString();
}

function psqlUrl(url: string): string {
  const parsed = new URL(url);
  parsed.search = "";
  return parsed.toString();
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(command, args, {
    cwd: databaseDir,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sql(url: string, statement: string): string {
  return run("psql", [psqlUrl(url), "-v", "ON_ERROR_STOP=1", "-Atc", statement]);
}

function prepareOldSchema(url: string, tempRoot: string): string {
  const prismaDir = join(tempRoot, "prisma");
  mkdirSync(prismaDir, { recursive: true });
  cpSync(join(databaseDir, "prisma", "schema.prisma"), join(prismaDir, "schema.prisma"), {
    recursive: true,
  });

  const targetMigrations = join(prismaDir, "migrations");
  for (const migration of readdirSync(migrationsDir)) {
    if (migration === phaseMigration) continue;
    cpSync(join(migrationsDir, migration), join(targetMigrations, migration), {
      recursive: true,
    });
  }

  const schemaPath = join(prismaDir, "schema.prisma");
  const configPath = join(tempRoot, "prisma.config.ts");
  writeFileSync(
    configPath,
    `
      import { defineConfig } from "prisma/config";
      export default defineConfig({
        schema: ${JSON.stringify(schemaPath)},
        migrations: { path: ${JSON.stringify(targetMigrations)} },
        datasource: { url: process.env.DATABASE_URL },
      });
    `,
  );
  run("npx", ["prisma", "migrate", "deploy", "--config", configPath], {
    DATABASE_URL: url,
  });
  return configPath;
}

function addPhaseMigration(tempRoot: string): void {
  cpSync(
    join(migrationsDir, phaseMigration),
    join(tempRoot, "prisma", "migrations", phaseMigration),
    { recursive: true },
  );
}

function withTemporaryDatabase(
  label: string,
  callback: (url: string, tempRoot: string) => void,
): void {
  const name = checkedDatabaseName(label);
  const quotedName = quoteIdentifier(name);
  const adminUrl = psqlUrl(DATABASE_URL);
  const url = databaseUrl(name);
  const tempRoot = mkdtempSync(join(databaseDir, ".account-billing-test-"));

  try {
    sql(adminUrl, `CREATE DATABASE ${quotedName}`);
    callback(url, tempRoot);
  } finally {
    sql(adminUrl, `DROP DATABASE IF EXISTS ${quotedName} WITH (FORCE)`);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

describe("account billing phase-1 backfill", () => {
  it("selects eligible winners and preserves them when legacy organizations are deleted", () => {
    withTemporaryDatabase("billing_backfill", (url, tempRoot) => {
      const configPath = prepareOldSchema(url, tempRoot);
      sql(
        url,
        `
          INSERT INTO users (id, email, password_hash, created_at, updated_at)
          VALUES
            ('creator_early', 'early@example.com', 'x', now(), now()),
            ('creator_late', 'late@example.com', 'x', now(), now()),
            ('creator_inactive', 'inactive@example.com', 'x', now(), now());

          INSERT INTO organizations (id, name, slug, stripe_customer_id)
          VALUES
            ('org_signal', 'Signal', 'signal', 'cus_signal'),
            ('org_fleet', 'Fleet', 'fleet', 'cus_fleet'),
            ('org_inactive', 'Inactive', 'inactive', 'cus_inactive');

          INSERT INTO memberships (id, role, user_id, organization_id, created_at)
          VALUES
            ('member_signal_late', 'OWNER', 'creator_late', 'org_signal', '2026-01-02'),
            ('member_signal_early', 'OWNER', 'creator_early', 'org_signal', '2026-01-01'),
            ('member_fleet', 'OWNER', 'creator_early', 'org_fleet', '2026-01-01'),
            ('member_inactive', 'OWNER', 'creator_inactive', 'org_inactive', '2026-01-01');

          INSERT INTO subscriptions (
            id, organization_id, plan, stripe_subscription_id, status,
            created_at, manual_override
          )
          VALUES
            ('sub_signal', 'org_signal', 'SIGNAL', 'sub_live_signal', 'active', '2026-01-02', false),
            ('sub_fleet_canceled', 'org_fleet', 'FLEET', 'sub_dead_fleet', 'canceled', '2026-01-01', false),
            ('sub_fleet_unpaid', 'org_inactive', 'FLEET', 'sub_unpaid', 'unpaid', '2026-01-01', false);
        `,
      );

      addPhaseMigration(tempRoot);
      run("npx", ["prisma", "migrate", "deploy", "--config", configPath], {
        DATABASE_URL: url,
      });

      const result = JSON.parse(
        sql(
          url,
          `
            SELECT json_build_object(
              'creator', (SELECT creator_user_id FROM organizations WHERE id = 'org_signal'),
              'winner', (SELECT json_build_object(
                'id', id, 'userId', user_id, 'organizationId', organization_id,
                'plan', plan
              ) FROM subscriptions WHERE user_id = 'creator_early'),
              'inactiveWinner', (SELECT json_build_object(
                'userId', user_id, 'organizationId', organization_id, 'plan', plan
              ) FROM subscriptions WHERE user_id = 'creator_inactive')
            );
          `,
        ),
      );

      expect(result).toEqual({
        creator: "creator_early",
        winner: {
          id: "sub_signal",
          userId: "creator_early",
          organizationId: "org_signal",
          plan: "SIGNAL",
        },
        inactiveWinner: {
          userId: "creator_inactive",
          organizationId: null,
          plan: "SOLO",
        },
      });

      sql(url, "DELETE FROM organizations WHERE id = 'org_signal'");
      expect(
        JSON.parse(
          sql(
            url,
            `
              SELECT json_build_object(
                'userId', user_id,
                'organizationId', organization_id,
                'plan', plan
              )
              FROM subscriptions
              WHERE id = 'sub_signal';
            `,
          ),
        ),
      ).toEqual({
        userId: "creator_early",
        organizationId: null,
        plan: "SIGNAL",
      });
    });
  });

  it("fails transactionally and remains unapplied for an ownerless organization", () => {
    withTemporaryDatabase("billing_ownerless", (url, tempRoot) => {
      const configPath = prepareOldSchema(url, tempRoot);
      sql(
        url,
        `
          INSERT INTO users (id, email, password_hash, created_at, updated_at)
          VALUES ('ownerless_user', 'ownerless@example.com', 'x', now(), now());
          INSERT INTO organizations (id, name, slug)
          VALUES ('ownerless_org', 'Ownerless', 'ownerless');
        `,
      );

      addPhaseMigration(tempRoot);
      expect(() =>
        run("npx", ["prisma", "migrate", "deploy", "--config", configPath], {
          DATABASE_URL: url,
        }),
      ).toThrow(/ownerless organization IDs: ownerless_org/);

      expect(
        sql(
          url,
          `
            SELECT count(*)
            FROM "_prisma_migrations"
            WHERE migration_name = '${phaseMigration}'
              AND finished_at IS NOT NULL;
          `,
        ),
      ).toBe("0");
      expect(
        sql(
          url,
          `
            SELECT count(*)
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND (
                (table_name = 'users' AND column_name = 'stripe_customer_id')
                OR (table_name = 'organizations' AND column_name = 'creator_user_id')
                OR (table_name = 'subscriptions' AND column_name = 'user_id')
              );
          `,
        ),
      ).toBe("0");
    });
  });
});
