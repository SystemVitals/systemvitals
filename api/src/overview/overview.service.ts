import { Injectable } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import type { CheckModel } from '../checks/check.model';
import {
  aggregateOverview,
  RANGE_SECONDS,
  type OverviewRangeKey,
} from './overview-aggregate';
import {
  BrokenState,
  type AccountOverview,
  type CheckBrokenTime,
  type OverviewOrganization,
} from './models/account-overview.model';

const TIME_ZONE_PATTERN = /^[A-Za-z0-9_+\-/]{1,64}$/;

/** Returns `value` when it is a usable IANA zone name, `'UTC'` otherwise. */
export function resolveTimeZone(value: string | undefined): string {
  if (value === undefined || !TIME_ZONE_PATTERN.test(value)) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

/**
 * Postgres rejects some zones Intl accepts, such as the legacy aliases Chrome
 * reports (for example "Asia/Calcutta") when the server's tzdata omits them.
 */
function isUnknownTimeZoneError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010' &&
    (error.meta as { code?: unknown } | undefined)?.code === '22023'
  );
}

interface LatestDownEvent {
  check_id: string;
  status_code: number | null;
  error: string | null;
}

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async accountOverview(
    userId: string,
    range: OverviewRangeKey,
    timeZone?: string,
    now: Date = new Date(),
  ): Promise<AccountOverview> {
    const tz = resolveTimeZone(timeZone);
    const rangeStart = new Date(now.getTime() - RANGE_SECONDS[range] * 1000);

    // Membership is read on every call so leaving an organization removes it
    // from the next overview.
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      select: {
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
            projects: { select: { id: true } },
          },
        },
      },
    });
    const organizations = memberships
      .map((m) => m.organization)
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const organizationById = new Map<string, OverviewOrganization>(
      organizations.map(({ id, name, slug }) => [id, { id, name, slug }]),
    );
    const organizationIdByProject = new Map(
      organizations.flatMap((o) => o.projects.map((p) => [p.id, o.id])),
    );

    // Full rows: nested CheckModel resolve fields read projectId, schedule,
    // tz, periodSeconds, and lastEventAt from the parent object.
    const rows = await this.prisma.check.findMany({
      where: { projectId: { in: [...organizationIdByProject.keys()] } },
    });
    const checks = rows.map((row) => ({
      ...row,
      organizationId: organizationIdByProject.get(row.projectId)!,
    }));
    const checkById = new Map(checks.map((c) => [c.id, c]));

    const [outages, bucketStarts] = await Promise.all([
      this.prisma.checkOutage.findMany({
        where: {
          checkId: { in: [...checkById.keys()] },
          startedAt: { lt: now },
          OR: [{ endedAt: null }, { endedAt: { gt: rangeStart } }],
        },
        select: { checkId: true, startedAt: true, endedAt: true },
        orderBy: { startedAt: 'asc' },
      }),
      this.bucketStartsOrUtc(
        rangeStart,
        now,
        range === 'DAY' ? 'hour' : 'day',
        tz,
      ),
    ]);

    const result = aggregateOverview({
      now,
      rangeStart,
      bucketStarts,
      organizationIds: organizations.map((o) => o.id),
      checks,
      outages,
    });

    const reasons = await this.downReasons(
      result.needsFixing
        .filter(
          (entry) =>
            entry.state === 'DOWN' &&
            checkById.get(entry.checkId)!.type !== 'HEARTBEAT',
        )
        .map((entry) => entry.checkId),
    );

    // GraphQL serializes the row's nulls as nulls; CheckModel declares its
    // nullable fields as optional, so the row needs a cast to match.
    const checkModel = (id: string) =>
      checkById.get(id) as unknown as CheckModel;
    const organizationOf = (checkId: string) =>
      organizationById.get(checkById.get(checkId)!.organizationId)!;

    const checkTotals: CheckBrokenTime[] = result.checks.map(
      ({ checkId, ...totals }) => ({
        check: checkModel(checkId),
        organization: organizationOf(checkId),
        ...totals,
      }),
    );
    const { longestOutageCheckId, ...summary } = result.summary;

    return {
      rangeStart,
      rangeEnd: now,
      organizationCount: organizations.length,
      checkCount: checks.length,
      needsFixing: result.needsFixing.map((entry) => ({
        check: checkModel(entry.checkId),
        organization: organizationOf(entry.checkId),
        state: BrokenState[entry.state],
        since: entry.since,
        downAt: entry.downAt,
        reason: reasons.get(entry.checkId) ?? null,
      })),
      summary: {
        ...summary,
        longestOutage:
          checkTotals.find((c) => c.check.id === longestOutageCheckId) ?? null,
      },
      buckets: result.buckets,
      byOrganization: result.byOrganization.map(
        ({ organizationId, ...totals }) => ({
          organization: organizationById.get(organizationId)!,
          ...totals,
        }),
      ),
      checks: checkTotals,
    };
  }

  /**
   * Bucket starts from `rangeStart` (truncated to `unit` in `timeZone`) up to
   * `now`. Postgres steps in `timeZone` (the PG16+ zone-aware
   * `generate_series`), so days start at local midnight and DST days are 23 or
   * 25 hours long, while hours stay exactly one hour apart.
   */
  async bucketStarts(
    rangeStart: Date,
    now: Date,
    unit: 'hour' | 'day',
    timeZone: string,
  ): Promise<Date[]> {
    const rows = await this.prisma.$queryRaw<Array<{ start: Date }>>`
      SELECT gs AS start
      FROM generate_series(
        date_trunc(${unit}, ${rangeStart}::timestamptz, ${timeZone}),
        ${now}::timestamptz,
        ${'1 ' + unit}::interval,
        ${timeZone}) gs`;
    return rows.map((row) => row.start);
  }

  /** Treats a zone Postgres does not recognize like any other invalid zone. */
  private async bucketStartsOrUtc(
    rangeStart: Date,
    now: Date,
    unit: 'hour' | 'day',
    timeZone: string,
  ): Promise<Date[]> {
    try {
      return await this.bucketStarts(rangeStart, now, unit, timeZone);
    } catch (error) {
      if (timeZone === 'UTC' || !isUnknownTimeZoneError(error)) throw error;
      return this.bucketStarts(rangeStart, now, unit, 'UTC');
    }
  }

  /**
   * The latest DOWN event of each currently DOWN active check. The lateral
   * LIMIT 1 walks the (check_id, timestamp) index backwards and stops at the
   * first DOWN event, instead of reading every event the check ever logged.
   */
  private async downReasons(checkIds: string[]): Promise<Map<string, string>> {
    if (checkIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<LatestDownEvent[]>`
      SELECT c.id AS check_id, e.status_code, e.error
      FROM unnest(${checkIds}::text[]) AS c(id)
      CROSS JOIN LATERAL (
        SELECT status_code, error
        FROM check_events
        WHERE check_id = c.id AND status = 'DOWN'
        ORDER BY timestamp DESC
        LIMIT 1
      ) e`;
    const reasons = new Map<string, string>();
    for (const row of rows) {
      const reason =
        row.status_code !== null ? `HTTP ${row.status_code}` : row.error;
      if (reason !== null) reasons.set(row.check_id, reason);
    }
    return reasons;
  }
}
