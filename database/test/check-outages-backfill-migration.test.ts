import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "../src/index";

const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error("DATABASE_URL is required");

const databaseDir = resolve(import.meta.dirname, "..");
const migrationsDir = join(databaseDir, "prisma", "migrations");
const targetMigration = "20261104120100_backfill_check_outages";
const migration = join(migrationsDir, targetMigration, "migration.sql");

type Outage = [checkId: string, startedAt: string, endedAt: string | null];

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

async function withOldSchema(
  run: (url: URL) => void | Promise<void>,
): Promise<void> {
  const databaseName = `systemvitals_outages_${randomUUID().replaceAll("-", "")}`;
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
        VALUES ('outage-user', 'outages@example.com', 'x', now(), now());
        INSERT INTO organizations (id, name, slug, creator_user_id)
        VALUES ('outage-org', 'Outages', 'outages', 'outage-user');
        INSERT INTO projects (id, name, slug, ping_key, organization_id)
        VALUES ('outage-project', 'Default', 'default', 'outage-ping', 'outage-org');
      `,
    ]);
    await run(testUrl);
  } finally {
    psql(adminUrl, [
      "-c",
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    ]);
  }
}

/**
 * Seeds checks (with the status they had before the cutoff) and their events,
 * clears the outages the trigger recorded while seeding, and moves the cutoff
 * to 12:00 on the test day. Times are UTC on 2026-11-04.
 */
function seedHistory(url: URL, checks: string, events: string): void {
  psql(url, [
    "-c",
    `
      INSERT INTO checks (
        id, name, slug, type, status, project_id, interval_seconds,
        last_event_at, updated_at
      )
      SELECT id, id, id, type::"CheckType", status::"CheckStatus",
        'outage-project', interval_seconds::int,
        ('2026-11-04 ' || last_event_at)::timestamp,
        ('2026-11-04 ' || updated_at)::timestamp
      FROM (VALUES ${checks})
        AS c(id, type, status, interval_seconds, last_event_at, updated_at);

      INSERT INTO check_events (id, check_id, "timestamp", status)
      SELECT gen_random_uuid()::text, check_id,
        ('2026-11-04 ' || happened_at)::timestamp, status::"CheckStatus"
      FROM (VALUES ${events}) AS e(check_id, happened_at, status);

      DELETE FROM check_outages;
      UPDATE check_outage_backfill_cutoff SET cutoff = '2026-11-04 12:00:00';
    `,
  ]);
}

function readOutages(url: URL): Outage[] {
  return psql(url, [
    "-AtF",
    "|",
    "-c",
    `
      SELECT check_id,
        to_char(started_at, 'YYYY-MM-DD HH24:MI:SS.MS'),
        to_char(ended_at, 'YYYY-MM-DD HH24:MI:SS.MS')
      FROM check_outages
      ORDER BY check_id, started_at
    `,
  ])
    .split("\n")
    .filter(Boolean)
    .map((row): Outage => {
      const [checkId, startedAt, endedAt] = row.split("|");
      return [checkId, startedAt, endedAt === "" ? null : endedAt];
    });
}

/** Applies the target migration in a separate psql session. */
function startMigration(
  url: URL,
): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "psql",
      [psqlUrl(url), "-v", "ON_ERROR_STOP=1", "-f", migration],
      {
        cwd: databaseDir,
        env: { ...process.env, PGAPPNAME: "outage-backfill" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectRun);
    child.on("close", (status) => resolveRun({ status, stderr }));
  });
}

async function waitUntilMigrationWaitsForALock(url: URL): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const waiting = psql(url, [
      "-Atc",
      `
        SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'outage-backfill'
          AND wait_event_type = 'Lock'
      `,
    ]);
    if (waiting === "1") return;
    await sleep(25);
  }
  throw new Error("The migration never waited for a lock");
}

/** Shortens "2026-11-04 10:01:00.000" to "10:01"; other values stay whole. */
function shorten(timestamp: string): string {
  return timestamp.replace(/^2026-11-04 (\d\d:\d\d):00\.000$/, "$1");
}

/** Outages of one check as [start, end | null], shortened. */
function minutesOf(outages: Outage[], checkId: string) {
  return outages
    .filter(([id]) => id === checkId)
    .map(([, startedAt, endedAt]) => [
      shorten(startedAt),
      endedAt === null ? null : shorten(endedAt),
    ]);
}

describe("check outage backfill migration", () => {
  it("stages the event scan before locking checks and writes outages only after the lock", () => {
    const sql = readFileSync(migration, "utf8");
    const checksLock = sql.indexOf(
      'LOCK TABLE "checks" IN SHARE ROW EXCLUSIVE MODE',
    );
    const beforeLock = sql.slice(0, checksLock);
    const scan = beforeLock
      .split(";")
      .find((statement) => statement.includes('INSERT INTO "backfill_streaks"'));

    expect(sql.trimStart()).toMatch(/^BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;$/);
    expect(checksLock).toBeGreaterThan(-1);
    expect(scan).toMatch(/FROM "check_events"/);
    expect(scan).toMatch(/\bOVER\b/);
    expect(beforeLock).not.toContain('INSERT INTO "check_outages"');
    expect(sql.slice(checksLock)).toContain('INSERT INTO "check_outages"');
  });

  describe("rebuilding history from check events", () => {
    let outages: Outage[] = [];
    let checksWithSeveralOpenOutages = "";
    let downChecksWithoutOneOpenOutage = "";
    let cutoffTableGone = "";

    beforeAll(() =>
      withOldSchema((url) => {
        seedHistory(
          url,
          `
            ('flapping', 'HTTP', 'UP', 60, '10:05', '10:05'),
            ('heartbeat-recovered', 'HEARTBEAT', 'UP', NULL, '11:00', '11:00'),
            ('http-paused-recovered', 'HTTP', 'UP', 60, '11:00', '11:00'),
            ('http-down-gap', 'HTTP', 'DOWN', 60, '10:30', '10:30'),
            ('heartbeat-paused', 'HEARTBEAT', 'PAUSED', NULL, '09:00', '09:30'),
            ('heartbeat-down', 'HEARTBEAT', 'DOWN', NULL, '09:00', '09:00'),
            ('down-no-event', 'HEARTBEAT', 'DOWN', NULL, '06:00', '07:00'),
            ('trigger-duplicate', 'HEARTBEAT', 'UP', NULL, '10:05', '10:05'),
            ('five-minute-floor', 'HTTP', 'UP', 30, '10:05', '10:05')
          `,
          `
            ('flapping', '10:00', 'UP'),
            ('flapping', '10:01', 'DOWN'),
            ('flapping', '10:02', 'DOWN'),
            ('flapping', '10:03', 'UP'),
            ('flapping', '10:04', 'DOWN'),
            ('flapping', '10:05', 'UP'),
            ('heartbeat-recovered', '08:00', 'UP'),
            ('heartbeat-recovered', '09:00', 'DOWN'),
            ('heartbeat-recovered', '11:00', 'UP'),
            ('http-paused-recovered', '10:00', 'DOWN'),
            ('http-paused-recovered', '10:01', 'DOWN'),
            ('http-paused-recovered', '11:00', 'UP'),
            ('http-down-gap', '10:00', 'DOWN'),
            ('http-down-gap', '10:30', 'DOWN'),
            ('heartbeat-paused', '09:00', 'DOWN'),
            ('heartbeat-down', '07:00', 'UP'),
            ('heartbeat-down', '09:00', 'DOWN'),
            ('trigger-duplicate', '10:00', 'DOWN'),
            ('trigger-duplicate', '10:05', 'UP'),
            ('five-minute-floor', '10:00', 'DOWN'),
            ('five-minute-floor', '10:04', 'DOWN'),
            ('five-minute-floor', '10:05', 'UP')
          `,
        );
        psql(url, [
          "-c",
          `
            INSERT INTO check_outages (check_id, started_at, ended_at)
            VALUES (
              'trigger-duplicate',
              '2026-11-04 10:00:00.200',
              '2026-11-04 10:05:00'
            );
          `,
        ]);

        psql(url, ["-f", migration]);

        outages = readOutages(url);
        checksWithSeveralOpenOutages = psql(url, [
          "-Atc",
          `
            SELECT coalesce(string_agg(check_id, ','), '') FROM (
              SELECT check_id FROM check_outages
              WHERE ended_at IS NULL
              GROUP BY check_id HAVING count(*) > 1
            ) several
          `,
        ]);
        downChecksWithoutOneOpenOutage = psql(url, [
          "-Atc",
          `
            SELECT coalesce(string_agg(c.id, ','), '') FROM checks c
            WHERE c.status = 'DOWN' AND (
              SELECT count(*) FROM check_outages o
              WHERE o.check_id = c.id AND o.ended_at IS NULL
            ) <> 1
          `,
        ]);
        cutoffTableGone = psql(url, [
          "-Atc",
          "SELECT to_regclass('check_outage_backfill_cutoff') IS NULL",
        ]);
      }),
    );

    it("records one outage per DOWN streak of a flapping HTTP check", () => {
      expect(minutesOf(outages, "flapping")).toEqual([
        ["10:01", "10:03"],
        ["10:04", "10:05"],
      ]);
    });

    it("closes a recovered heartbeat outage at the recovery event", () => {
      expect(minutesOf(outages, "heartbeat-recovered")).toEqual([
        ["09:00", "11:00"],
      ]);
    });

    it("ends an HTTP outage one interval after the last DOWN before a pause", () => {
      expect(minutesOf(outages, "http-paused-recovered")).toEqual([
        ["10:00", "10:02"],
      ]);
    });

    it("splits an HTTP check that stays DOWN across a probe gap", () => {
      expect(minutesOf(outages, "http-down-gap")).toEqual([
        ["10:00", "10:01"],
        ["10:30", null],
      ]);
    });

    it("closes a heartbeat paused while DOWN at its updated_at", () => {
      expect(minutesOf(outages, "heartbeat-paused")).toEqual([
        ["09:00", "09:30"],
      ]);
    });

    it("leaves the outage of a heartbeat that is still DOWN open", () => {
      expect(minutesOf(outages, "heartbeat-down")).toEqual([["09:00", null]]);
    });

    it("opens an outage at last_event_at for a DOWN check without a DOWN event", () => {
      expect(minutesOf(outages, "down-no-event")).toEqual([["06:00", null]]);
    });

    it("merges an outage the trigger recorded during the race", () => {
      expect(minutesOf(outages, "trigger-duplicate")).toEqual([
        ["10:00", "10:05"],
      ]);
    });

    it("does not treat gaps under five minutes as a pause", () => {
      expect(minutesOf(outages, "five-minute-floor")).toEqual([
        ["10:00", "10:05"],
      ]);
    });

    it("keeps one open outage per DOWN check and drops the cutoff table", () => {
      expect(checksWithSeveralOpenOutages).toBe("");
      expect(downChecksWithoutOneOpenOutage).toBe("");
      expect(cutoffTableGone).toBe("t");
    });
  });

  it("leaves outages that start at or after the cutoff to the trigger", async () => {
    await withOldSchema((url) => {
      seedHistory(
        url,
        "('around-cutoff', 'HEARTBEAT', 'UP', NULL, '12:05', '12:05')",
        `
          ('around-cutoff', '11:00', 'DOWN'),
          ('around-cutoff', '11:30', 'UP'),
          ('around-cutoff', '12:00', 'DOWN'),
          ('around-cutoff', '12:05', 'UP')
        `,
      );

      psql(url, ["-f", migration]);

      expect(minutesOf(readOutages(url), "around-cutoff")).toEqual([
        ["11:00", "11:30"],
      ]);
    });
  });

  it("lets a status writer that holds its check row lock finish without a deadlock", async () => {
    await withOldSchema(async (url) => {
      seedHistory(
        url,
        "('writer-locked', 'HEARTBEAT', 'DOWN', NULL, '09:00', '09:00')",
        "('writer-locked', '09:00', 'DOWN')",
      );
      const writer = new PrismaClient({ datasourceUrl: url.toString() });
      let migrationRun:
        | Promise<{ status: number | null; stderr: string }>
        | undefined;
      try {
        // The same lock order as the worker and the ping endpoint: lock the
        // check row, record the event, then write the status.
        await writer.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT id FROM checks WHERE id = 'writer-locked' FOR UPDATE
            `;
            migrationRun = startMigration(url);
            await waitUntilMigrationWaitsForALock(url);
            await tx.$executeRaw`
              INSERT INTO check_events (id, check_id, "timestamp", status)
              VALUES ('writer-event', 'writer-locked', '2026-11-04 12:30', 'UP')
            `;
            await tx.$executeRaw`
              UPDATE checks
              SET status = 'UP', last_event_at = '2026-11-04 12:30'
              WHERE id = 'writer-locked'
            `;
          },
          { timeout: 20_000 },
        );

        const result = await migrationRun!;
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(minutesOf(readOutages(url), "writer-locked")).toEqual([
          ["09:00", "12:30"],
        ]);
      } finally {
        await writer.$disconnect();
        await migrationRun?.catch(() => undefined);
      }
    });
  });

  it("skips a check deleted between the event scan and the lock", async () => {
    await withOldSchema(async (url) => {
      seedHistory(
        url,
        `
          ('a-blocker', 'HEARTBEAT', 'UP', NULL, '08:00', '08:00'),
          ('b-deleted', 'HEARTBEAT', 'UP', NULL, '09:30', '09:30'),
          ('c-kept', 'HEARTBEAT', 'UP', NULL, '09:30', '09:30')
        `,
        `
          ('a-blocker', '08:00', 'UP'),
          ('b-deleted', '09:00', 'DOWN'),
          ('b-deleted', '09:30', 'UP'),
          ('c-kept', '09:00', 'DOWN'),
          ('c-kept', '09:30', 'UP')
        `,
      );
      const blocker = new PrismaClient({ datasourceUrl: url.toString() });
      let migrationRun:
        | Promise<{ status: number | null; stderr: string }>
        | undefined;
      try {
        // "a-blocker" sorts first, so holding its row lock parks the migration
        // after the event scan, at the row locks it takes before LOCK TABLE.
        await blocker.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT id FROM checks WHERE id = 'a-blocker' FOR UPDATE
            `;
            migrationRun = startMigration(url);
            await waitUntilMigrationWaitsForALock(url);
            psql(url, [
              "-c",
              "SET lock_timeout = '3s'",
              "-c",
              "DELETE FROM checks WHERE id = 'b-deleted'",
            ]);
          },
          { timeout: 20_000 },
        );

        const result = await migrationRun!;
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        expect(
          readOutages(url).map(([checkId, startedAt, endedAt]) => [
            checkId,
            shorten(startedAt),
            endedAt === null ? null : shorten(endedAt),
          ]),
        ).toEqual([["c-kept", "09:00", "09:30"]]);
      } finally {
        await blocker.$disconnect();
        await migrationRun?.catch(() => undefined);
      }
    });
  });
});
