import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required");

const databaseDir = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseDir, "prisma", "migrations");
const targetMigration = "20260723233000_add_billing_version_cleanup_queue";

function run(command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd: databaseDir,
    env: process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function psql(url: string, args: string[]): string {
  const parsed = new URL(url);
  parsed.search = "";
  return run("psql", [parsed.toString(), "-v", "ON_ERROR_STOP=1", ...args]);
}

describe("checkout cleanup queue migration", () => {
  it("upgrades the previous schema without losing legacy cleanup state", () => {
    const databaseName = `systemvitals_cleanup_upgrade_${randomUUID().replaceAll("-", "")}`;
    if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
      throw new Error(`Unsafe database name: ${databaseName}`);
    }
    const adminUrl = new URL(DATABASE_URL);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const testUrl = new URL(DATABASE_URL);
    testUrl.pathname = `/${databaseName}`;
    testUrl.search = "";

    psql(adminUrl.toString(), ["-c", `CREATE DATABASE "${databaseName}"`]);
    try {
      const migrations = readdirSync(migrationsDir)
        .filter(
          (name) => name < targetMigration && name !== "migration_lock.toml",
        )
        .sort();
      for (const migration of migrations) {
        psql(testUrl.toString(), [
          "-f",
          join(migrationsDir, migration, "migration.sql"),
        ]);
      }
      psql(testUrl.toString(), [
        "-c",
        `
          INSERT INTO users (
            id, email, password_hash, checkout_cleanup_session_id,
            checkout_cleanup_created_at, created_at, updated_at
          ) VALUES (
            'upgrade-user', 'upgrade@example.com', 'x', 'cs_legacy',
            '2026-07-23T12:00:00Z', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
        `,
      ]);

      psql(testUrl.toString(), [
        "-f",
        join(migrationsDir, targetMigration, "migration.sql"),
      ]);
      expect(
        psql(testUrl.toString(), [
          "-Atc",
          `
            SELECT billing_state_version || '|' ||
                   coalesce(checkout_cleanup_session_id, '<null>') || '|' ||
                   coalesce(checkout_cleanup_created_at::text, '<null>')
            FROM users WHERE id = 'upgrade-user'
          `,
        ]),
      ).toBe("0|<null>|<null>");
      expect(
        psql(testUrl.toString(), [
          "-Atc",
          `
            SELECT user_id || '|' || stripe_session_id || '|' ||
                   created_at::text
            FROM checkout_cleanup_intents
            WHERE user_id = 'upgrade-user'
          `,
        ]),
      ).toBe("upgrade-user|cs_legacy|2026-07-23 12:00:00");

      psql(testUrl.toString(), [
        "-c",
        `
          INSERT INTO checkout_cleanup_intents
            (id, user_id, stripe_session_id)
          VALUES
            ('intent-a', 'upgrade-user', 'cs_a'),
            ('intent-b', 'upgrade-user', 'cs_b')
        `,
      ]);
      expect(
        psql(testUrl.toString(), [
          "-Atc",
          "SELECT count(*) FROM checkout_cleanup_intents",
        ]),
      ).toBe("3");
      expect(() =>
        psql(testUrl.toString(), [
          "-c",
          `
            INSERT INTO checkout_cleanup_intents
              (id, user_id, stripe_session_id)
            VALUES ('intent-duplicate', 'upgrade-user', 'cs_a')
          `,
        ]),
      ).toThrow();
    } finally {
      psql(adminUrl.toString(), [
        "-c",
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      ]);
    }
  });
});
