import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { OverviewService } from '../src/overview/overview.service';
import { cleanupTestUsers } from './cleanup-test-users';

async function signup(app: NestFastifyApplication, email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(r.body) as { token: string }).token;
}

async function gql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(r.body) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
}

interface Overview {
  organizationCount: number;
  checkCount: number;
  needsFixing: Array<{
    state: string;
    since: string;
    organization: { id: string; slug: string };
    check: {
      id: string;
      name: string;
      lastEventAt: string | null;
      nextExpectedAt: string | null;
    };
  }>;
  summary: {
    ongoingCount: number;
    outageCount: number;
    brokenSeconds: number;
    uptimePercent: number | null;
  };
  byOrganization: Array<{
    organization: { id: string; name: string };
    brokenSeconds: number;
  }>;
  buckets: Array<{ start: string; brokenSeconds: number }>;
  checks: Array<{
    check: { id: string };
    ongoing: boolean;
    outages: Array<{ startedAt: string; endedAt: string | null }>;
  }>;
}

const OVERVIEW = `query ($range: OverviewRange!, $timeZone: String) {
  accountOverview(range: $range, timeZone: $timeZone) {
    organizationCount checkCount
    needsFixing {
      state since organization { id slug }
      check { id name lastEventAt nextExpectedAt }
    }
    summary { ongoingCount outageCount brokenSeconds uptimePercent }
    byOrganization { organization { id name } brokenSeconds }
    buckets { start brokenSeconds }
    checks { check { id } ongoing outages { startedAt endedAt } }
  }
}`;

describe('account overview (e2e)', () => {
  const stamp = Date.now();
  const emailA = `overview-a+${stamp}@example.com`;
  const emailB = `overview-b+${stamp}@example.com`;
  const emailC = `overview-c+${stamp}@example.com`;
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let tokenA: string;
  let orgA: string;
  let secondOrg: string;
  let checkIdsA: string[];

  async function overview(
    token: string,
    variables: { range: string; timeZone?: string } = {
      range: 'WEEK',
      timeZone: 'America/Sao_Paulo',
    },
  ) {
    const r = await gql(app, token, OVERVIEW, variables);
    return {
      errors: r.errors,
      data: (r.data as { accountOverview: Overview } | undefined)
        ?.accountOverview,
    };
  }

  async function downHeartbeat(token: string, organizationId: string) {
    const created = await gql(
      app,
      token,
      `mutation ($o: ID!) {
         createCheck(organizationId: $o, name: "Nightly backup", graceSeconds: 60, periodSeconds: 300) { id }
       }`,
      { o: organizationId },
    );
    expect(created.errors).toBeUndefined();
    const { id } = (created.data as { createCheck: { id: string } })
      .createCheck;
    // The check_outages trigger opens an outage on this status write.
    await prisma.check.update({ where: { id }, data: { status: 'DOWN' } });
    return id;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);

    tokenA = await signup(app, emailA);
    const me = await gql(app, tokenA, `query { me { organizations { id } } }`);
    orgA = (me.data as { me: { organizations: Array<{ id: string }> } }).me
      .organizations[0].id;
    const second = await gql(
      app,
      tokenA,
      `mutation { createOrganization(name: "Second") { id } }`,
    );
    expect(second.errors).toBeUndefined();
    secondOrg = (second.data as { createOrganization: { id: string } })
      .createOrganization.id;
    checkIdsA = [
      await downHeartbeat(tokenA, orgA),
      await downHeartbeat(tokenA, secondOrg),
    ];
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [emailA, emailB, emailC]);
    } finally {
      await app.close();
    }
  });

  it('returns broken checks across every organization the user belongs to', async () => {
    const { errors, data } = await overview(tokenA);

    expect(errors).toBeUndefined();
    expect(data!.organizationCount).toBe(2);
    expect(data!.checkCount).toBe(2);
    expect(data!.needsFixing).toHaveLength(2);
    expect(data!.needsFixing.map((e) => e.state)).toEqual(['DOWN', 'DOWN']);
    expect(data!.needsFixing.map((e) => e.check.id).sort()).toEqual(
      [...checkIdsA].sort(),
    );
    expect(new Set(data!.needsFixing.map((e) => e.organization.id))).toEqual(
      new Set([orgA, secondOrg]),
    );
    expect(data!.summary.ongoingCount).toBe(2);
    expect(data!.summary.outageCount).toBe(2);
    expect(data!.byOrganization).toHaveLength(2);
    expect(data!.buckets.length).toBeGreaterThanOrEqual(7);
    expect(data!.buckets.length).toBeLessThanOrEqual(9);
    expect(data!.checks).toHaveLength(2);
    for (const row of data!.checks) {
      expect(row.ongoing).toBe(true);
      expect(row.outages).toHaveLength(1);
      expect(row.outages[0].endedAt).toBeNull();
    }
  });

  it('drops an organization the user no longer belongs to', async () => {
    const tokenB = await signup(app, emailB);
    const userB = await prisma.user.findUniqueOrThrow({
      where: { email: emailB },
    });
    const membership = await prisma.membership.create({
      data: { userId: userB.id, organizationId: orgA, role: 'MEMBER' },
    });

    const shared = await overview(tokenB);
    expect(shared.errors).toBeUndefined();
    expect(shared.data!.organizationCount).toBe(2);
    expect(shared.data!.byOrganization.map((o) => o.organization.id)).toContain(
      orgA,
    );
    expect(shared.data!.needsFixing.map((e) => e.check.id)).toEqual([
      checkIdsA[0],
    ]);

    await prisma.membership.delete({ where: { id: membership.id } });

    const after = await overview(tokenB);
    expect(after.errors).toBeUndefined();
    expect(after.data!.organizationCount).toBe(1);
    expect(
      after.data!.byOrganization.map((o) => o.organization.id),
    ).not.toContain(orgA);
    const visible = [
      ...after.data!.needsFixing.map((e) => e.check.id),
      ...after.data!.checks.map((c) => c.check.id),
    ];
    for (const id of checkIdsA) expect(visible).not.toContain(id);
  });

  it('allows account PATs and rejects legacy tokens', async () => {
    const pat = await gql(
      app,
      tokenA,
      `mutation { createPersonalAccessToken(name:"overview",expirationDays:30){plaintext} }`,
    );
    expect(pat.errors).toBeUndefined();
    const patToken = (
      pat.data as { createPersonalAccessToken: { plaintext: string } }
    ).createPersonalAccessToken.plaintext;
    const viaPat = await overview(patToken);
    expect(viaPat.errors).toBeUndefined();
    expect(viaPat.data!.organizationCount).toBe(2);

    const legacy = await gql(
      app,
      tokenA,
      `mutation { createApiToken(name:"legacy",scopes:["read"]){plaintext} }`,
    );
    expect(legacy.errors).toBeUndefined();
    const legacyToken = (
      legacy.data as { createApiToken: { plaintext: string } }
    ).createApiToken.plaintext;
    const viaLegacy = await overview(legacyToken);
    expect(viaLegacy.errors?.[0]?.message).toContain(
      'Account session required',
    );
  });

  it('accepts an invalid timeZone', async () => {
    const invalid = await overview(tokenA, {
      range: 'MONTH',
      timeZone: 'Mars/Base',
    });
    expect(invalid.errors).toBeUndefined();

    // Intl accepts this legacy alias (Chrome reports it for India); a
    // Postgres with slim tzdata does not. Either way the query succeeds.
    const alias = await overview(tokenA, {
      range: 'DAY',
      timeZone: 'Asia/Calcutta',
    });
    expect(alias.errors).toBeUndefined();
  });

  it('reports the latest DOWN event as the reason for an active check', async () => {
    const tokenC = await signup(app, emailC);
    const me = await gql(app, tokenC, `query { me { organizations { id } } }`);
    const orgC = (me.data as { me: { organizations: Array<{ id: string }> } })
      .me.organizations[0].id;
    const created = await gql(
      app,
      tokenC,
      `mutation ($o: ID!) {
         createActiveCheck(
           organizationId: $o, name: "API health", type: "HTTP",
           target: "https://example.com/health", intervalSeconds: 300,
           timeoutMs: 5000
         ) { id }
       }`,
      { o: orgC },
    );
    expect(created.errors).toBeUndefined();
    const { id } = (created.data as { createActiveCheck: { id: string } })
      .createActiveCheck;
    const now = Date.now();
    await prisma.checkEvent.createMany({
      data: [
        {
          checkId: id,
          status: 'DOWN',
          statusCode: 500,
          timestamp: new Date(now - 120_000),
        },
        {
          checkId: id,
          status: 'DOWN',
          statusCode: 503,
          timestamp: new Date(now - 60_000),
        },
      ],
    });
    await prisma.check.update({ where: { id }, data: { status: 'DOWN' } });

    const result = await gql(
      app,
      tokenC,
      `{ accountOverview(range: DAY) { needsFixing { state reason check { id } } } }`,
    );

    expect(result.errors).toBeUndefined();
    expect(
      (result.data as { accountOverview: { needsFixing: unknown[] } })
        .accountOverview.needsFixing,
    ).toEqual([{ state: 'DOWN', reason: 'HTTP 503', check: { id } }]);
  });

  it('builds local-midnight day buckets across a DST change', async () => {
    const starts = await app
      .get(OverviewService)
      .bucketStarts(
        new Date('2026-10-30T12:00:00Z'),
        new Date('2026-11-03T12:00:00Z'),
        'day',
        'America/New_York',
      );

    expect(starts.map((d) => d.toISOString())).toEqual([
      '2026-10-30T04:00:00.000Z',
      '2026-10-31T04:00:00.000Z',
      '2026-11-01T04:00:00.000Z',
      '2026-11-02T05:00:00.000Z',
      '2026-11-03T05:00:00.000Z',
    ]);
    expect(starts[3].getTime() - starts[2].getTime()).toBe(25 * 3600 * 1000);
  });

  it('builds hourly buckets across a DST change', async () => {
    // 2026-11-01 06:00Z is when New York falls back from EDT to EST, so the
    // local 01:00 hour happens twice.
    const starts = await app
      .get(OverviewService)
      .bucketStarts(
        new Date('2026-11-01T03:00:00Z'),
        new Date('2026-11-01T08:00:00Z'),
        'hour',
        'America/New_York',
      );

    expect(starts.map((d) => d.toISOString())).toEqual([
      '2026-11-01T03:00:00.000Z',
      '2026-11-01T04:00:00.000Z',
      '2026-11-01T05:00:00.000Z',
      '2026-11-01T06:00:00.000Z',
      '2026-11-01T07:00:00.000Z',
      '2026-11-01T08:00:00.000Z',
    ]);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i].getTime() - starts[i - 1].getTime()).toBe(3600 * 1000);
    }
  });
});
