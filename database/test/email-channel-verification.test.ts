import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const databaseDir = resolve(import.meta.dirname, "..");
const schema = join(databaseDir, "prisma", "schema.prisma");
const migration = join(
  databaseDir,
  "prisma",
  "migrations",
  "20260727120000_email_channel_verification",
  "migration.sql",
);
const databaseUrl = process.env.DATABASE_URL;

function migrationSql(): string | null {
  return existsSync(migration) ? readFileSync(migration, "utf8") : null;
}

function psqlUrl(): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const parsed = new URL(databaseUrl);
  parsed.searchParams.delete("schema");
  return parsed.toString();
}

function psql(script: string): string {
  return execFileSync(
    "psql",
    [psqlUrl(), "-v", "ON_ERROR_STOP=1", "-At", "-F", "|"],
    {
      cwd: databaseDir,
      encoding: "utf8",
      input: script,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function commandErrorOutput(error: Error): string {
  const stderr = (error as Error & { stderr?: Buffer | string }).stderr;
  return stderr ? stderr.toString() : error.message;
}

function psqlAsync(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "psql",
      [psqlUrl(), "-v", "ON_ERROR_STOP=1", "-At", "-F", "|"],
      { cwd: databaseDir, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`psql exited with ${code}: ${stderr}`));
    });
    child.stdin.end(script);
  });
}

async function waitForExclusiveLock(schemaName: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const locked = psql(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_locks locks
        JOIN pg_class relations ON relations.oid = locks.relation
        JOIN pg_namespace namespaces ON namespaces.oid = relations.relnamespace
        WHERE namespaces.nspname = '${schemaName}'
          AND relations.relname = 'notification_channels'
          AND locks.mode = 'AccessExclusiveLock'
          AND locks.granted
      );
    `).trim();
    if (locked === "t") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("email verification compatibility transaction never acquired its ALTER lock");
}

describe("email channel verification persistence contract", () => {
  it("declares a transaction-fenced compatibility rollout with an atomic hash index", () => {
    const prismaSchema = readFileSync(schema, "utf8");
    const sql = migrationSql();

    expect(sql).not.toBeNull();
    if (!sql) return;

    expect(prismaSchema).toMatch(
      /verifiedAt\s+DateTime\?\s+@default\(now\(\)\)\s+@map\("verified_at"\)/,
    );
    expect(prismaSchema).toMatch(
      /verificationTokenHash\s+String\?\s+@unique\s+@map\("verification_token_hash"\)/,
    );
    expect(prismaSchema).toMatch(
      /verificationExpiresAt\s+DateTime\?\s+@map\("verification_expires_at"\)/,
    );
    expect(prismaSchema).toMatch(
      /verificationSentAt\s+DateTime\?\s+@map\("verification_sent_at"\)/,
    );

    const begin = sql.indexOf("BEGIN;");
    const addColumns = sql.indexOf('ADD COLUMN "verified_at"');
    const setDefault = sql.indexOf('ALTER COLUMN "verified_at" SET DEFAULT CURRENT_TIMESTAMP');
    const backfill = sql.indexOf('UPDATE "notification_channels"');
    const commit = sql.indexOf("COMMIT;");
    const uniqueIndex = sql.indexOf(
      'CREATE UNIQUE INDEX "notification_channels_verification_token_hash_key"',
    );

    expect(begin).toBeGreaterThanOrEqual(0);
    expect(addColumns).toBeGreaterThan(begin);
    expect(setDefault).toBeGreaterThan(addColumns);
    expect(backfill).toBeGreaterThan(setDefault);
    expect(uniqueIndex).toBeGreaterThan(backfill);
    expect(commit).toBeGreaterThan(uniqueIndex);
    expect(sql).toMatch(
      /ADD COLUMN "verification_token_hash" TEXT(?! NOT NULL)/,
    );
    expect(sql).toMatch(
      /UPDATE "notification_channels"\s+SET "verified_at" = CURRENT_TIMESTAMP\s+WHERE "type" = 'EMAIL' AND "verified_at" IS NULL/,
    );
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "notification_channels_verification_token_hash_key"\s+ON "notification_channels"\("verification_token_hash"\)/,
    );
    expect(sql).not.toMatch(/\bCONCURRENTLY\b/);
    expect(sql).not.toMatch(/failed-migration recovery/i);
    expect(sql).not.toMatch(/\b(?:DELETE|TRUNCATE)\b/i);
    expect(sql).not.toMatch(/UPDATE "notification_channels"[\s\S]*\b"enabled"\b/i);
  });

  it("fences old writers until the default commits, then backfills without mutating non-email channels", async () => {
    const sql = migrationSql();
    expect(sql).not.toBeNull();
    if (!sql) return;

    const schemaName = `email_verification_${randomUUID().replaceAll("-", "")}`;
    const table = `"${schemaName}"."notification_channels"`;
    const pausedMigration = sql.replace(
      "\nCOMMIT;\n",
      "\nSELECT pg_sleep(1);\nCOMMIT;\n",
    );
    expect(pausedMigration).not.toBe(sql);

    psql(`
      CREATE SCHEMA "${schemaName}";
      CREATE TABLE ${table} (
        "id" TEXT PRIMARY KEY,
        "type" TEXT NOT NULL,
        "enabled" BOOLEAN NOT NULL,
        "config" JSONB NOT NULL DEFAULT '{}'::jsonb
      );
      INSERT INTO ${table} ("id", "type", "enabled") VALUES
        ('legacy-email', 'EMAIL', TRUE),
        ('legacy-webhook', 'WEBHOOK', FALSE);
    `);

    const migrationProcess = psqlAsync(`
      SET search_path TO "${schemaName}";
      ${pausedMigration}
    `);

    try {
      await waitForExclusiveLock(schemaName);

      let oldWriterError: Error | null = null;
      try {
        psql(`
          SET statement_timeout = '200ms';
          INSERT INTO ${table} ("id", "type", "enabled")
          VALUES ('old-writer', 'EMAIL', TRUE);
        `);
      } catch (error) {
        oldWriterError = error instanceof Error ? error : new Error(String(error));
      }
      expect(oldWriterError).not.toBeNull();
      expect(oldWriterError).toBeInstanceOf(Error);
      expect(commandErrorOutput(oldWriterError!)).toContain("statement timeout");

      await migrationProcess;

      psql(`
        INSERT INTO ${table} ("id", "type", "enabled")
        VALUES ('new-writer', 'EMAIL', TRUE);
        UPDATE ${table}
        SET "verification_token_hash" = 'duplicate-hash'
        WHERE "id" = 'legacy-email';
        DO $$
        BEGIN
          BEGIN
            INSERT INTO ${table} (
              "id", "type", "enabled", "verification_token_hash"
            ) VALUES ('duplicate-hash', 'EMAIL', TRUE, 'duplicate-hash');
          EXCEPTION WHEN unique_violation THEN
            RETURN;
          END;
          RAISE EXCEPTION 'verification token hash uniqueness was not enforced';
        END $$;
      `);

      const result = psql(`
        SELECT
          (SELECT "verified_at" IS NOT NULL FROM ${table} WHERE "id" = 'legacy-email'),
          (SELECT "enabled" FROM ${table} WHERE "id" = 'legacy-email'),
          (SELECT "enabled" = FALSE FROM ${table} WHERE "id" = 'legacy-webhook'),
          (SELECT count(*) = 2 FROM ${table} WHERE "id" IN ('legacy-email', 'legacy-webhook')),
          (SELECT "verified_at" IS NOT NULL FROM ${table} WHERE "id" = 'new-writer'),
          (SELECT count(*) = 4 FROM information_schema.columns
            WHERE table_schema = '${schemaName}'
              AND table_name = 'notification_channels'
              AND column_name IN (
                'verified_at',
                'verification_token_hash',
                'verification_expires_at',
                'verification_sent_at'
              )
              AND is_nullable = 'YES'),
          (SELECT "verified_at" IS NULL FROM ${table} WHERE "id" = 'legacy-webhook');
      `);
      expect(result.trim()).toBe("t|t|t|t|t|t|t");
    } finally {
      await migrationProcess.catch(() => undefined);
      psql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    }
  });
});
