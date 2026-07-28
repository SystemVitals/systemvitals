import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const databaseDir = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseDir, "prisma", "migrations");
const targetMigration = "20260724003000_add_checkout_operations";
const fencingMigration = join(
  databaseDir,
  "prisma",
  "migrations",
  "20260724010000_fence_checkout_operations",
  "migration.sql",
);
const portalMigration = join(
  databaseDir,
  "prisma",
  "migrations",
  "20260724013000_generalize_checkout_operations",
  "migration.sql",
);
const migration = join(
  databaseDir,
  "prisma",
  "migrations",
  "20260724003000_add_checkout_operations",
  "migration.sql",
);

describe("checkout operation migration contract", () => {
  it("creates leased operations with ownership, lookup indexes, and resets the obsolete counter", () => {
    const sql = readFileSync(migration, "utf8");

    expect(sql).toContain('CREATE TABLE "checkout_operations"');
    expect(sql).toContain('"id" UUID');
    expect(sql).toContain('"attempt_id" TEXT NOT NULL');
    expect(sql).toContain('"lease_expires_at" TIMESTAMP(3) NOT NULL');
    expect(sql).toContain(
      'CREATE INDEX "checkout_operations_user_id_lease_expires_at_idx"',
    );
    expect(sql).toContain('CONSTRAINT "checkout_operations_user_id_fkey"');
    expect(sql).toContain("ON DELETE CASCADE");
    expect(sql).toContain('UPDATE "users" SET "checkout_in_flight_count" = 0');
  });

  it("adds a non-null UUID owner token and explicit operation state", () => {
    const sql = readFileSync(fencingMigration, "utf8");

    expect(sql).toContain('ADD COLUMN "owner_token" UUID');
    expect(sql).toContain('ADD COLUMN "state" TEXT');
    expect(sql).toContain('ADD COLUMN "stripe_price_id" TEXT');
    expect(sql).toContain('ADD COLUMN "success_url" TEXT');
    expect(sql).toContain('ADD COLUMN "cancel_url" TEXT');
    expect(sql).toContain('"owner_token" SET NOT NULL');
    expect(sql).toContain('"state" SET NOT NULL');
  });

  it("generalizes existing operations to checkout and supports exact portal retries", () => {
    const sql = readFileSync(portalMigration, "utf8");

    expect(sql).toContain(
      "ADD COLUMN \"operation_kind\" TEXT NOT NULL DEFAULT 'CHECKOUT'",
    );
    expect(sql).toContain('ADD COLUMN "stripe_customer_id" TEXT');
    expect(sql).toContain('ADD COLUMN "portal_return_url" TEXT');
    expect(sql).toContain('ALTER COLUMN "attempt_id" DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN "requested_plan" DROP NOT NULL');
    expect(sql).toContain('ALTER COLUMN "interval" DROP NOT NULL');
    expect(sql).toContain("'CHECKOUT', 'PORTAL'");
  });

  it("enforces the user lease index and cascading foreign key on an upgrade", () => {
    const sourceUrl = process.env.DATABASE_URL;
    if (!sourceUrl) throw new Error("DATABASE_URL is required");
    const databaseName = `systemvitals_checkout_ops_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = "/postgres";
    adminUrl.search = "";
    const testUrl = new URL(sourceUrl);
    testUrl.pathname = `/${databaseName}`;
    testUrl.search = "";
    const psql = (url: URL, args: string[]) =>
      execFileSync("psql", [url.toString(), "-v", "ON_ERROR_STOP=1", ...args], {
        encoding: "utf8",
      }).trim();

    psql(adminUrl, ["-c", `CREATE DATABASE "${databaseName}"`]);
    try {
      for (const name of readdirSync(migrationsDir)
        .filter((candidate) => candidate < targetMigration)
        .sort()) {
        psql(testUrl, ["-f", join(migrationsDir, name, "migration.sql")]);
      }
      psql(testUrl, [
        "-c",
        `
          INSERT INTO users
            (id, email, password_hash, checkout_in_flight_count, created_at, updated_at)
          VALUES
            ('operation-user', 'operation@example.com', 'x', 2, now(), now())
        `,
      ]);
      psql(testUrl, ["-f", migration]);

      expect(
        psql(testUrl, [
          "-Atc",
          `
            SELECT checkout_in_flight_count FROM users
            WHERE id = 'operation-user'
          `,
        ]),
      ).toBe("0");
      expect(
        psql(testUrl, [
          "-Atc",
          `
            SELECT count(*) FROM pg_indexes
            WHERE indexname =
              'checkout_operations_user_id_lease_expires_at_idx'
          `,
        ]),
      ).toBe("1");
      expect(() =>
        psql(testUrl, [
          "-c",
          `
            INSERT INTO checkout_operations
              (id, user_id, attempt_id, requested_plan, interval, lease_expires_at)
            VALUES
              ('00000000-0000-4000-8000-000000000099', 'missing-user',
               'attempt', 'SIGNAL', 'month', now())
          `,
        ]),
      ).toThrow();
      psql(testUrl, [
        "-c",
        `
          INSERT INTO checkout_operations
            (id, user_id, attempt_id, requested_plan, interval, lease_expires_at)
          VALUES
            ('00000000-0000-4000-8000-000000000100', 'operation-user',
             'attempt', 'SIGNAL', 'month', now());
        `,
      ]);
      psql(testUrl, ["-f", fencingMigration]);
      psql(testUrl, ["-f", portalMigration]);
      expect(
        psql(testUrl, [
          "-Atc",
          `
            SELECT operation_kind || '|' || attempt_id
            FROM checkout_operations
            WHERE user_id = 'operation-user'
          `,
        ]),
      ).toBe("CHECKOUT|attempt");
      psql(testUrl, [
        "-c",
        `
          INSERT INTO checkout_operations (
            id, user_id, operation_kind, stripe_customer_id,
            portal_return_url, lease_expires_at
          ) VALUES (
            '00000000-0000-4000-8000-000000000101', 'operation-user',
            'PORTAL', 'cus_portal', 'https://app.test/billing', now()
          );
          DELETE FROM users WHERE id = 'operation-user';
        `,
      ]);
      expect(
        psql(testUrl, ["-Atc", "SELECT count(*) FROM checkout_operations"]),
      ).toBe("0");
    } finally {
      psql(adminUrl, [
        "-c",
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      ]);
    }
  });
});
