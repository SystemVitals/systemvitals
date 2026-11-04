import { Prisma } from '@systemvitals/database';
import { OverviewService, resolveTimeZone } from './overview.service';
import type { PrismaService } from '../prisma/prisma.service';

// Left untyped (not asserted to `PrismaService` here) so that referencing a
// mock method in an `expect(...)` call resolves to plain `jest.Mock`. Only
// `makeService` casts, at the constructor boundary that requires it.
function makePrisma() {
  return {
    membership: { findMany: jest.fn().mockResolvedValue([]) },
    check: { findMany: jest.fn().mockResolvedValue([]) },
    checkOutage: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new OverviewService(prisma as unknown as PrismaService);
}

function membership(id: string, name: string, projectId: string) {
  return {
    organization: {
      id,
      name,
      slug: `${id}-slug`,
      projects: [{ id: projectId }],
    },
  };
}

function checkRow(overrides: Record<string, unknown>) {
  return {
    id: 'check',
    name: 'Check',
    slug: 'check',
    description: null,
    agentInstructions: null,
    type: 'HTTP',
    status: 'UP',
    projectId: 'project-a',
    pingSlug: null,
    periodSeconds: null,
    graceSeconds: null,
    schedule: null,
    tz: null,
    target: 'https://example.com',
    method: 'GET',
    expectedStatus: 200,
    intervalSeconds: 60,
    timeoutMs: 5000,
    lastEventAt: new Date('2026-11-04T09:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-11-04T09:00:00Z'),
    ...overrides,
  };
}

const NOW = new Date('2026-11-04T10:00:00Z');

describe('resolveTimeZone', () => {
  it('resolveTimeZone keeps valid IANA zones and falls back to UTC', () => {
    expect(resolveTimeZone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(resolveTimeZone('Mars/Base')).toBe('UTC');
    expect(resolveTimeZone('')).toBe('UTC');
    expect(resolveTimeZone(undefined)).toBe('UTC');
    expect(resolveTimeZone("UTC'; DROP")).toBe('UTC');
  });
});

describe('OverviewService.accountOverview', () => {
  it("only queries checks in the user's memberships", async () => {
    const prisma = makePrisma();
    prisma.membership.findMany.mockResolvedValue([
      membership('org-b', 'Beta', 'project-b'),
      membership('org-a', 'Alpha', 'project-a'),
    ]);

    const overview = await makeService(prisma).accountOverview(
      'user-1',
      'WEEK',
      'America/Sao_Paulo',
      NOW,
    );

    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'user-1' } }),
    );
    expect(prisma.check.findMany).toHaveBeenCalledWith({
      where: { projectId: { in: ['project-a', 'project-b'] } },
    });
    expect(overview.organizationCount).toBe(2);
    expect(overview.byOrganization.map((o) => o.organization)).toEqual([
      { id: 'org-a', name: 'Alpha', slug: 'org-a-slug' },
      { id: 'org-b', name: 'Beta', slug: 'org-b-slug' },
    ]);
  });

  it('returns an empty overview for a user with no memberships', async () => {
    const prisma = makePrisma();

    const overview = await makeService(prisma).accountOverview(
      'user-1',
      'DAY',
      undefined,
      NOW,
    );

    expect(overview.organizationCount).toBe(0);
    expect(overview.checkCount).toBe(0);
    expect(overview.needsFixing).toEqual([]);
    expect(overview.rangeEnd).toEqual(NOW);
    expect(overview.rangeStart).toEqual(new Date('2026-11-03T10:00:00Z'));
  });

  it('uses the latest DOWN event as the reason for active checks only', async () => {
    const prisma = makePrisma();
    prisma.membership.findMany.mockResolvedValue([
      membership('org-a', 'Alpha', 'project-a'),
    ]);
    prisma.check.findMany.mockResolvedValue([
      checkRow({ id: 'http-1', status: 'DOWN' }),
      checkRow({ id: 'tcp-1', type: 'TCP', status: 'DOWN' }),
      checkRow({ id: 'heartbeat-1', type: 'HEARTBEAT', status: 'DOWN' }),
    ]);
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('check_events')
          ? [
              { check_id: 'http-1', status_code: 503, error: 'unexpected' },
              { check_id: 'tcp-1', status_code: null, error: 'ECONNREFUSED' },
            ]
          : [],
      ),
    );

    const overview = await makeService(prisma).accountOverview(
      'user-1',
      'WEEK',
      undefined,
      NOW,
    );

    const reasons = Object.fromEntries(
      overview.needsFixing.map((entry) => [entry.check.id, entry.reason]),
    );
    expect(reasons).toEqual({
      'http-1': 'HTTP 503',
      'tcp-1': 'ECONNREFUSED',
      'heartbeat-1': null,
    });
    expect(overview.needsFixing[0].organization).toEqual({
      id: 'org-a',
      name: 'Alpha',
      slug: 'org-a-slug',
    });
    expect(overview.needsFixing[0].check.organizationId).toBe('org-a');
  });

  it('falls back to UTC buckets when Postgres does not know an Intl zone', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Raw query failed', {
          code: 'P2010',
          clientVersion: 'test',
          meta: {
            code: '22023',
            message: 'ERROR: time zone "Asia/Calcutta" not recognized',
          },
        }),
      )
      .mockResolvedValueOnce([{ start: new Date('2026-11-04T00:00:00Z') }]);

    const overview = await makeService(prisma).accountOverview(
      'user-1',
      'WEEK',
      'Asia/Calcutta',
      NOW,
    );

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.calls[0]).toContain('Asia/Calcutta');
    expect(prisma.$queryRaw.mock.calls[1]).toContain('UTC');
    expect(overview.buckets).toEqual([
      { start: new Date('2026-11-04T00:00:00Z'), brokenSeconds: 0 },
    ]);
  });

  it('does not retry bucket queries that fail for other reasons', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      makeService(prisma).accountOverview(
        'user-1',
        'WEEK',
        'Asia/Calcutta',
        NOW,
      ),
    ).rejects.toThrow('connection lost');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
