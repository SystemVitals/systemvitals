import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const databaseDir = resolve(import.meta.dirname, "..");
const migration = join(
  databaseDir,
  "prisma",
  "migrations",
  "20260730120000_remove_escalation_acknowledgements",
  "migration.sql",
);

describe("escalation persistence removal migration contract", () => {
  it("drops acknowledgements before policies without changing channel exclusions or copying data", () => {
    const sql = existsSync(migration) ? readFileSync(migration, "utf8") : "";
    const acknowledgementsDrop =
      'DROP TABLE IF EXISTS "acknowledgements";';
    const policiesDrop = 'DROP TABLE IF EXISTS "escalation_policies";';

    expect(sql).toContain(acknowledgementsDrop);
    expect(sql).toContain(policiesDrop);
    expect(sql.indexOf(acknowledgementsDrop)).toBeLessThan(
      sql.indexOf(policiesDrop),
    );
    expect(sql).not.toContain('"check_channel_exclusions"');
    expect(sql).not.toMatch(/\b(?:COPY|INSERT|UPDATE)\b/i);
    expect(sql.trim()).toBe(
      [
        "BEGIN;",
        acknowledgementsDrop,
        policiesDrop,
        "COMMIT;",
      ].join("\n"),
    );
  });
});
