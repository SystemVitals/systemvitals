import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AlertQueueService } from '../src/queue/alert-queue.service';
import { generateToken } from '../src/tokens/token.util';
import { cleanupTestUsers } from './cleanup-test-users';

jest.setTimeout(60_000);

const CHECK = `
  query Check($id: ID!) {
    check(id: $id) {
      id
      notificationChannelIds
    }
  }
`;

const CREATE_CHECK = `
  mutation CreateCheck(
    $projectId: ID!
    $name: String!
    $periodSeconds: Int!
    $graceSeconds: Int!
  ) {
    createCheck(
      projectId: $projectId
      name: $name
      periodSeconds: $periodSeconds
      graceSeconds: $graceSeconds
    ) {
      id
      notificationChannelIds
    }
  }
`;

const SET_CHANNEL_ENABLED = `
  mutation SetCheckChannelEnabled(
    $checkId: ID!
    $channelId: ID!
    $enabled: Boolean!
  ) {
    setCheckChannelEnabled(
      checkId: $checkId
      channelId: $channelId
      enabled: $enabled
    ) {
      id
      notificationChannelIds
    }
  }
`;

interface CheckResult {
  id: string;
  notificationChannelIds: string[];
}

interface GraphQlResponse {
  data?: {
    check?: CheckResult | null;
    createCheck?: CheckResult | null;
    setCheckChannelEnabled?: CheckResult | null;
  } | null;
  errors?: Array<{ message: string }>;
}

interface Fixture {
  ownerId: string;
  ownerToken: string;
  outsiderToken: string;
  projectId: string;
  checkId: string;
  channelIds: [string, string];
  disabledChannelId: string;
  crossProjectChannelId: string;
}

describe('per-check notification channels (e2e)', () => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixtureEmails: string[] = [];
  const enqueue = jest.fn<
    Promise<void>,
    [{ checkId: string; kind: 'down' | 'recovery' }]
  >();
  let sequence = 0;
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AlertQueueService)
      .useValue({ enqueue, onModuleDestroy: jest.fn() })
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, fixtureEmails);
    } finally {
      await app.close();
    }
  });

  beforeEach(() => {
    enqueue.mockClear();
  });

  function email(label: string): string {
    const value = `check-channels-${runId}-${sequence++}-${label}@example.test`;
    fixtureEmails.push(value);
    return value;
  }

  async function gql(
    token: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQlResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: { query, variables },
    });
    return JSON.parse(response.body) as GraphQlResponse;
  }

  async function createFixture(): Promise<Fixture> {
    const label = `${runId}-${sequence++}`;
    const ownerEmail = email(`${label}-owner`);
    const outsiderEmail = email(`${label}-outsider`);

    return prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({ data: { email: ownerEmail } });
      const outsider = await tx.user.create({
        data: { email: outsiderEmail },
      });
      const organization = await tx.organization.create({
        data: {
          name: `Check channels ${label}`,
          slug: `check-channels-${label}`,
          creatorUserId: owner.id,
        },
      });
      const crossOrganization = await tx.organization.create({
        data: {
          name: `Cross project ${label}`,
          slug: `check-channels-cross-${label}`,
          creatorUserId: owner.id,
        },
      });
      await tx.membership.createMany({
        data: [
          {
            userId: owner.id,
            organizationId: organization.id,
            role: 'OWNER',
          },
          {
            userId: owner.id,
            organizationId: crossOrganization.id,
            role: 'OWNER',
          },
        ],
      });
      const project = await tx.project.create({
        data: {
          name: 'Primary',
          slug: `primary-${label}`,
          organizationId: organization.id,
        },
      });
      const crossProject = await tx.project.create({
        data: {
          name: 'Cross',
          slug: `cross-${label}`,
          organizationId: crossOrganization.id,
        },
      });
      const check = await tx.check.create({
        data: {
          name: 'Existing check',
          slug: `existing-${label}`,
          type: 'HEARTBEAT',
          status: 'NEW',
          projectId: project.id,
          pingSlug: randomUUID(),
          periodSeconds: 300,
          graceSeconds: 30,
        },
      });
      const channelA = await tx.notificationChannel.create({
        data: {
          projectId: project.id,
          type: 'WEBHOOK',
          destinationKey: `a-${label}`,
          config: { url: 'https://example.test/a' },
          enabled: true,
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
        },
      });
      const channelB = await tx.notificationChannel.create({
        data: {
          projectId: project.id,
          type: 'WEBHOOK',
          destinationKey: `b-${label}`,
          config: { url: 'https://example.test/b' },
          enabled: true,
          createdAt: new Date('2025-01-02T00:00:00.000Z'),
        },
      });
      const disabledChannel = await tx.notificationChannel.create({
        data: {
          projectId: project.id,
          type: 'EMAIL',
          destinationKey: `pending-${label}`,
          config: { email: `pending-${label}@example.test` },
          enabled: false,
          verifiedAt: null,
          createdAt: new Date('2025-01-03T00:00:00.000Z'),
        },
      });
      const crossProjectChannel = await tx.notificationChannel.create({
        data: {
          projectId: crossProject.id,
          type: 'WEBHOOK',
          destinationKey: `cross-${label}`,
          config: { url: 'https://example.test/cross' },
          enabled: true,
        },
      });

      return {
        ownerId: owner.id,
        ownerToken: jwt.sign({ sub: owner.id, email: owner.email }),
        outsiderToken: jwt.sign({
          sub: outsider.id,
          email: outsider.email,
        }),
        projectId: project.id,
        checkId: check.id,
        channelIds: [channelA.id, channelB.id],
        disabledChannelId: disabledChannel.id,
        crossProjectChannelId: crossProjectChannel.id,
      };
    });
  }

  async function toggle(
    fixture: Fixture,
    channelId: string,
    enabled: boolean,
    token = fixture.ownerToken,
  ): Promise<GraphQlResponse> {
    return gql(token, SET_CHANNEL_ENABLED, {
      checkId: fixture.checkId,
      channelId,
      enabled,
    });
  }

  it('defaults existing and new checks to every enabled channel and includes newly created channels', async () => {
    const fixture = await createFixture();

    const existing = await gql(fixture.ownerToken, CHECK, {
      id: fixture.checkId,
    });
    expect(existing.errors).toBeUndefined();
    expect(existing.data?.check?.notificationChannelIds).toEqual(
      fixture.channelIds,
    );

    const created = await gql(fixture.ownerToken, CREATE_CHECK, {
      projectId: fixture.projectId,
      name: `New check ${runId}-${sequence++}`,
      periodSeconds: 300,
      graceSeconds: 30,
    });
    expect(created.errors).toBeUndefined();
    expect(created.data?.createCheck?.notificationChannelIds).toEqual(
      fixture.channelIds,
    );

    const newChannel = await prisma.notificationChannel.create({
      data: {
        projectId: fixture.projectId,
        type: 'WEBHOOK',
        destinationKey: `new-${runId}-${sequence++}`,
        config: { url: 'https://example.test/new' },
        enabled: true,
        createdAt: new Date('2025-01-04T00:00:00.000Z'),
      },
    });
    const refreshed = await gql(fixture.ownerToken, CHECK, {
      id: fixture.checkId,
    });
    expect(refreshed.data?.check?.notificationChannelIds).toEqual([
      ...fixture.channelIds,
      newChannel.id,
    ]);
  });

  it('disables and enables idempotently, supports all-off, and causes no alert side effects', async () => {
    const fixture = await createFixture();
    const [channelA, channelB] = fixture.channelIds;
    const alertCountBefore = await prisma.alertLog.count({
      where: { checkId: fixture.checkId },
    });

    for (const response of [
      await toggle(fixture, channelA, false),
      await toggle(fixture, channelA, false),
    ]) {
      expect(response.errors).toBeUndefined();
      expect(
        response.data?.setCheckChannelEnabled?.notificationChannelIds,
      ).toEqual([channelB]);
    }
    expect(
      await prisma.checkChannelExclusion.count({
        where: { checkId: fixture.checkId, channelId: channelA },
      }),
    ).toBe(1);

    for (const response of [
      await toggle(fixture, channelA, true),
      await toggle(fixture, channelA, true),
    ]) {
      expect(response.errors).toBeUndefined();
      expect(
        response.data?.setCheckChannelEnabled?.notificationChannelIds,
      ).toEqual([channelA, channelB]);
    }
    expect(
      await prisma.checkChannelExclusion.count({
        where: { checkId: fixture.checkId, channelId: channelA },
      }),
    ).toBe(0);

    await toggle(fixture, channelA, false);
    const allOff = await toggle(fixture, channelB, false);
    expect(allOff.data?.setCheckChannelEnabled?.notificationChannelIds).toEqual(
      [],
    );
    expect(
      await prisma.alertLog.count({ where: { checkId: fixture.checkId } }),
    ).toBe(alertCountBefore);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects disabled channels, other users, and cross-project channels without disclosure', async () => {
    const fixture = await createFixture();

    const disabled = await toggle(fixture, fixture.disabledChannelId, false);
    expect(disabled.errors?.[0]?.message).toBe(
      'Notification channel is not enabled',
    );

    const otherUser = await toggle(
      fixture,
      fixture.channelIds[0],
      false,
      fixture.outsiderToken,
    );
    expect(otherUser.errors?.[0]?.message).toBe(
      'Not a member of this organization',
    );

    const crossProject = await toggle(
      fixture,
      fixture.crossProjectChannelId,
      false,
    );
    expect(crossProject.errors?.[0]?.message).toBe(
      'Notification channel not found',
    );
    expect(
      await prisma.checkChannelExclusion.count({
        where: { checkId: fixture.checkId },
      }),
    ).toBe(0);
  });

  it('allows project-scoped write credentials and rejects read-only credentials', async () => {
    const fixture = await createFixture();
    const readToken = generateToken();
    const writeToken = generateToken();
    await prisma.apiToken.createMany({
      data: [
        {
          name: 'Read check channels',
          prefix: readToken.prefix,
          tokenHash: readToken.hash,
          scopes: ['checks:read'],
          userId: fixture.ownerId,
          projectId: fixture.projectId,
        },
        {
          name: 'Write check channels',
          prefix: writeToken.prefix,
          tokenHash: writeToken.hash,
          scopes: ['checks:write'],
          userId: fixture.ownerId,
          projectId: fixture.projectId,
        },
      ],
    });

    const denied = await toggle(
      fixture,
      fixture.channelIds[0],
      false,
      readToken.plaintext,
    );
    expect(denied.errors?.[0]?.message).toBe(
      'Missing capability: checks:write',
    );

    const allowed = await toggle(
      fixture,
      fixture.channelIds[0],
      false,
      writeToken.plaintext,
    );
    expect(allowed.errors).toBeUndefined();
    expect(
      allowed.data?.setCheckChannelEnabled?.notificationChannelIds,
    ).toEqual([fixture.channelIds[1]]);
  });
});
