import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const databaseDir = resolve(import.meta.dirname, "..");
const migration = join(
  databaseDir,
  "prisma",
  "migrations",
  "20260728160000_check_channel_exclusions",
  "migration.sql",
);

describe("check channel exclusions migration contract", () => {
  it("creates an empty exclusion table with cascading ownership constraints", () => {
    const sql = existsSync(migration) ? readFileSync(migration, "utf8") : "";

    expect(sql).toContain('CREATE TABLE "check_channel_exclusions"');
    expect(sql).toContain('PRIMARY KEY ("check_id","channel_id")');
    expect(sql).toContain('REFERENCES "checks"("id")');
    expect(sql).toContain('REFERENCES "notification_channels"("id")');
    expect(sql).toContain("ON DELETE CASCADE ON UPDATE CASCADE");
    expect(sql.match(/ON DELETE CASCADE ON UPDATE CASCADE/g)).toHaveLength(2);
    expect(sql).toContain(
      'CREATE INDEX "check_channel_exclusions_channel_id_idx"',
    );
    expect(sql).not.toMatch(/\bINSERT\b/i);
  });
});
