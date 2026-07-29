import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { generateToken } from '../src/tokens/token.util';
import { cleanupTestUsers } from './cleanup-test-users';

jest.setTimeout(60_000);

const MOVE_CHECK = `
  mutation MoveCheck($checkId: ID!, $destinationProjectId: ID!) {
    moveCheck(checkId: $checkId, destinationProjectId: $destinationProjectId) {
      id
      projectId
      slug
      pingSlug
      type
      status
      periodSeconds
      graceSeconds
    }
  }
`;

interface GraphQlResponse {
  data?: { moveCheck?: MoveResult | null } | null;
  errors?: Array<{ message: string }>;
}

interface MoveResult {
  id: string;
  projectId: string;
  slug: string;
  pingSlug: string;
  type: string;
  status: string;
  periodSeconds: number;
  graceSeconds: number;
}

interface Fixture {
  actorId: string;
  actorToken: string;
  sourceCreatorId: string;
  destinationCreatorId: string;
  sourceOrganizationId: string;
  destinationOrganizationId: string;
  sourceProjectId: string;
  sameOrganizationProjectId: string;
  destinationProjectId: string;
  checkId: string;
  pingSlug: string;
  sourcePageIds: string[];
  sourcePageCheckIds: string[][];
  destinationPageId: string;
  destinationPageCheckIds: string[];
  eventId: string;
  alertId: string;
  sourceChannelId: string;
  destinationChannelIds: string[];
}

describe('moveCheck (e2e)', () => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixtureEmails: string[] = [];
  let sequence = 0;
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let jwt: JwtService;

  beforeAll(async () => {
    app = await buildApp();
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

  function email(label: string): string {
    const value = `move-check-${runId}-${sequence++}-${label}@example.test`;
    fixtureEmails.push(value);
    return value;
  }

  async function gql(
    token: string,
    variables: Record<string, unknown>,
  ): Promise<GraphQlResponse> {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${token}` },
      payload: { query: MOVE_CHECK, variables },
    });
    return JSON.parse(response.body) as GraphQlResponse;
  }

  async function createFixture(options?: {
    sourceRole?: 'OWNER' | 'ADMIN' | 'MEMBER';
    destinationRole?: 'OWNER' | 'ADMIN' | 'MEMBER';
    sameCreator?: boolean;
    destinationAtLimit?: boolean;
    collision?: boolean;
  }): Promise<Fixture> {
    const label = `${runId}-${sequence++}`;
    const actorEmail = email(`${label}-actor`);
    const sourceCreatorEmail = email(`${label}-source-creator`);
    const destinationCreatorEmail = options?.sameCreator
      ? sourceCreatorEmail
      : email(`${label}-destination-creator`);

    return prisma.$transaction(async (tx) => {
      const actor = await tx.user.create({ data: { email: actorEmail } });
      const sourceCreator = await tx.user.create({
        data: { email: sourceCreatorEmail },
      });
      const destinationCreator = options?.sameCreator
        ? sourceCreator
        : await tx.user.create({ data: { email: destinationCreatorEmail } });

      if (options?.destinationAtLimit || options?.sameCreator) {
        await tx.subscription.create({
          data: {
            userId: destinationCreator.id,
            plan: 'SOLO',
            status: 'active',
            limits: {
              maxChecks: options.sameCreator ? 2 : 1,
              minIntervalSeconds: 60,
            },
          },
        });
      }

      const sourceOrganization = await tx.organization.create({
        data: {
          name: `Source ${label}`,
          slug: `move-source-${label}`,
          creatorUserId: sourceCreator.id,
        },
      });
      const destinationOrganization = await tx.organization.create({
        data: {
          name: `Destination ${label}`,
          slug: `move-destination-${label}`,
          creatorUserId: destinationCreator.id,
        },
      });
      await tx.membership.createMany({
        data: [
          {
            userId: sourceCreator.id,
            organizationId: sourceOrganization.id,
            role: 'OWNER',
          },
          {
            userId: destinationCreator.id,
            organizationId: destinationOrganization.id,
            role: 'OWNER',
          },
          {
            userId: actor.id,
            organizationId: sourceOrganization.id,
            role: options?.sourceRole ?? 'OWNER',
          },
          {
            userId: actor.id,
            organizationId: destinationOrganization.id,
            role: options?.destinationRole ?? 'OWNER',
          },
        ],
        skipDuplicates: true,
      });
      const sourceProject = await tx.project.create({
        data: {
          name: 'Source',
          slug: `source-${label}`,
          organizationId: sourceOrganization.id,
        },
      });
      const sameOrganizationProject = await tx.project.create({
        data: {
          name: 'Same organization',
          slug: `same-org-${label}`,
          organizationId: sourceOrganization.id,
        },
      });
      const destinationProject = await tx.project.create({
        data: {
          name: 'Destination',
          slug: `destination-${label}`,
          organizationId: destinationOrganization.id,
        },
      });
      const pingSlug = randomUUID();
      const check = await tx.check.create({
        data: {
          name: 'Nightly backup',
          slug: 'nightly-backup',
          type: 'HEARTBEAT',
          status: 'PAUSED',
          projectId: sourceProject.id,
          pingSlug,
          periodSeconds: 30,
          graceSeconds: 10,
        },
      });
      const sourceChannel = await tx.notificationChannel.create({
        data: {
          projectId: sourceProject.id,
          type: 'WEBHOOK',
          destinationKey: `source-${label}`,
          config: { url: 'https://example.test/source' },
          enabled: true,
        },
      });
      const destinationChannels = await Promise.all([
        tx.notificationChannel.create({
          data: {
            projectId: destinationProject.id,
            type: 'WEBHOOK',
            destinationKey: `destination-a-${label}`,
            config: { url: 'https://example.test/destination-a' },
            enabled: true,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        }),
        tx.notificationChannel.create({
          data: {
            projectId: destinationProject.id,
            type: 'WEBHOOK',
            destinationKey: `destination-b-${label}`,
            config: { url: 'https://example.test/destination-b' },
            enabled: true,
            createdAt: new Date('2025-01-02T00:00:00.000Z'),
          },
        }),
      ]);
      await tx.checkChannelExclusion.create({
        data: { checkId: check.id, channelId: sourceChannel.id },
      });
      if (options?.destinationAtLimit && !options.sameCreator) {
        await tx.check.create({
          data: {
            name: 'Capacity filler',
            slug: 'capacity-filler',
            type: 'HEARTBEAT',
            status: 'NEW',
            projectId: destinationProject.id,
            pingSlug: randomUUID(),
            periodSeconds: 300,
            graceSeconds: 30,
          },
        });
      }
      if (options?.collision) {
        await tx.check.create({
          data: {
            name: 'Collision',
            slug: check.slug,
            type: 'HEARTBEAT',
            status: 'NEW',
            projectId: destinationProject.id,
            pingSlug: randomUUID(),
            periodSeconds: 300,
            graceSeconds: 30,
          },
        });
      }
      const otherCheck = await tx.check.create({
        data: {
          name: 'Other source check',
          slug: `other-${label}`,
          type: 'HEARTBEAT',
          status: 'NEW',
          projectId: sourceProject.id,
          pingSlug: randomUUID(),
          periodSeconds: 300,
          graceSeconds: 30,
        },
      });
      const event = await tx.checkEvent.create({
        data: { checkId: check.id, status: 'DOWN', error: 'preserved' },
      });
      const alert = await tx.alertLog.create({
        data: {
          checkId: check.id,
          status: 'DOWN',
          payload: { history: 'preserved' },
        },
      });
      const sourcePages = await Promise.all([
        tx.statusPage.create({
          data: {
            projectId: sourceProject.id,
            slug: `source-page-a-${label}`,
            title: 'Source A',
            checkIds: [check.id, otherCheck.id],
          },
        }),
        tx.statusPage.create({
          data: {
            projectId: sourceProject.id,
            slug: `source-page-b-${label}`,
            title: 'Source B',
            checkIds: [check.id],
          },
        }),
      ]);
      const destinationPage = await tx.statusPage.create({
        data: {
          projectId: destinationProject.id,
          slug: `destination-page-${label}`,
          title: 'Destination',
          checkIds: [],
        },
      });

      return {
        actorId: actor.id,
        actorToken: jwt.sign({ sub: actor.id, email: actor.email }),
        sourceCreatorId: sourceCreator.id,
        destinationCreatorId: destinationCreator.id,
        sourceOrganizationId: sourceOrganization.id,
        destinationOrganizationId: destinationOrganization.id,
        sourceProjectId: sourceProject.id,
        sameOrganizationProjectId: sameOrganizationProject.id,
        destinationProjectId: destinationProject.id,
        checkId: check.id,
        pingSlug,
        sourcePageIds: sourcePages.map(({ id }) => id),
        sourcePageCheckIds: sourcePages.map(({ checkIds }) => checkIds),
        destinationPageId: destinationPage.id,
        destinationPageCheckIds: destinationPage.checkIds,
        eventId: event.id,
        alertId: alert.id,
        sourceChannelId: sourceChannel.id,
        destinationChannelIds: destinationChannels.map(({ id }) => id),
      };
    });
  }

  async function expectUnchanged(fixture: Fixture): Promise<void> {
    const [check, pages] = await Promise.all([
      prisma.check.findUniqueOrThrow({ where: { id: fixture.checkId } }),
      prisma.statusPage.findMany({
        where: { id: { in: fixture.sourcePageIds } },
        orderBy: { slug: 'asc' },
      }),
    ]);
    expect(check.projectId).toBe(fixture.sourceProjectId);
    expect(pages.map(({ checkIds }) => checkIds)).toEqual(
      fixture.sourcePageCheckIds,
    );
  }

  it('moves for a dual owner who is not either organization creator and preserves history', async () => {
    const fixture = await createFixture();
    expect(fixture.actorId).not.toBe(fixture.sourceCreatorId);
    expect(fixture.actorId).not.toBe(fixture.destinationCreatorId);

    const response = await gql(fixture.actorToken, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.moveCheck).toEqual({
      id: fixture.checkId,
      projectId: fixture.destinationProjectId,
      slug: 'nightly-backup',
      pingSlug: fixture.pingSlug,
      type: 'HEARTBEAT',
      status: 'PAUSED',
      periodSeconds: 30,
      graceSeconds: 10,
    });
    const [check, events, alerts, sourcePages, destination, exclusions] =
      await Promise.all([
        prisma.check.findUniqueOrThrow({ where: { id: fixture.checkId } }),
        prisma.checkEvent.findMany({ where: { checkId: fixture.checkId } }),
        prisma.alertLog.findMany({ where: { checkId: fixture.checkId } }),
        prisma.statusPage.findMany({
          where: { id: { in: fixture.sourcePageIds } },
        }),
        prisma.statusPage.findUniqueOrThrow({
          where: { id: fixture.destinationPageId },
        }),
        prisma.checkChannelExclusion.findMany({
          where: { checkId: fixture.checkId },
        }),
      ]);
    expect(check).toMatchObject({
      id: fixture.checkId,
      name: 'Nightly backup',
      projectId: fixture.destinationProjectId,
      slug: 'nightly-backup',
      pingSlug: fixture.pingSlug,
      type: 'HEARTBEAT',
      status: 'PAUSED',
      periodSeconds: 30,
      graceSeconds: 10,
      schedule: null,
      tz: null,
      target: null,
      method: null,
      expectedStatus: null,
      intervalSeconds: null,
      timeoutMs: null,
      lastEventAt: null,
    });
    expect(events.map(({ id }) => id)).toEqual([fixture.eventId]);
    expect(alerts.map(({ id }) => id)).toEqual([fixture.alertId]);
    expect(sourcePages.every((page) => !page.checkIds.includes(check.id))).toBe(
      true,
    );
    expect(destination.checkIds).toEqual(fixture.destinationPageCheckIds);
    expect(exclusions).toEqual([]);

    const checkResponse = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${fixture.actorToken}` },
      payload: {
        query: `query($id: ID!) {
          check(id: $id) { notificationChannelIds }
        }`,
        variables: { id: fixture.checkId },
      },
    });
    const parsed = JSON.parse(checkResponse.body) as {
      data?: { check?: { notificationChannelIds: string[] } };
    };
    expect(parsed.data?.check?.notificationChannelIds).toEqual(
      fixture.destinationChannelIds,
    );
  });

  it.each([
    ['ADMIN in the source organization', { sourceRole: 'ADMIN' as const }],
    [
      'MEMBER in the destination organization',
      { destinationRole: 'MEMBER' as const },
    ],
  ])('rejects an actor who is only %s', async (_label, options) => {
    const fixture = await createFixture(options);
    const response = await gql(fixture.actorToken, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors?.[0]?.message).toBe(
      'You must own both organizations to move this check',
    );
    await expectUnchanged(fixture);
  });

  it.each([
    ['the same project', 'same'],
    ['a project in the same organization', 'same-org'],
    ['a missing destination project', 'missing'],
  ])(
    'rejects %s without changing source state',
    async (_label, destination) => {
      const fixture = await createFixture();
      const destinationProjectId =
        destination === 'same'
          ? fixture.sourceProjectId
          : destination === 'same-org'
            ? fixture.sameOrganizationProjectId
            : `missing-${runId}`;
      const response = await gql(fixture.actorToken, {
        checkId: fixture.checkId,
        destinationProjectId,
      });
      expect(response.errors?.[0]?.message).toMatch(
        destination === 'same'
          ? /already in the destination/
          : destination === 'same-org'
            ? /another organization/
            : /Destination project not found/,
      );
      await expectUnchanged(fixture);
    },
  );

  it('rejects a destination slug collision without changing source state', async () => {
    const fixture = await createFixture({ collision: true });
    const response = await gql(fixture.actorToken, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors?.[0]?.message).toContain(
      'already exists in the destination project',
    );
    await expectUnchanged(fixture);
  });

  it('rejects a move when the destination creator is at maxChecks', async () => {
    const fixture = await createFixture({ destinationAtLimit: true });
    const response = await gql(fixture.actorToken, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors?.[0]?.message).toContain(
      'plan limit of 1 checks has been reached',
    );
    await expectUnchanged(fixture);
  });

  it('allows a same-creator move while that creator is at maxChecks', async () => {
    const fixture = await createFixture({ sameCreator: true });
    const response = await gql(fixture.actorToken, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors).toBeUndefined();
    expect(response.data?.moveCheck?.projectId).toBe(
      fixture.destinationProjectId,
    );
  });

  it('requires an account session even for a project-scoped write token', async () => {
    const fixture = await createFixture();
    const token = generateToken();
    await prisma.apiToken.create({
      data: {
        name: 'Move isolation',
        prefix: token.prefix,
        tokenHash: token.hash,
        scopes: ['checks:write'],
        userId: fixture.actorId,
        projectId: fixture.sourceProjectId,
        projectNameSnapshot: 'Source',
        organizationNameSnapshot: 'Source organization',
      },
    });
    const response = await gql(token.plaintext, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors?.[0]?.message).toBe('Account session required');
    await expectUnchanged(fixture);
  });

  it('requires an account session for a legacy broad write token', async () => {
    const fixture = await createFixture();
    const token = generateToken();
    await prisma.apiToken.create({
      data: {
        name: 'Legacy move isolation',
        prefix: token.prefix,
        tokenHash: token.hash,
        scopes: ['write'],
        userId: fixture.actorId,
      },
    });
    const response = await gql(token.plaintext, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors?.[0]?.message).toBe('Account session required');
    await expectUnchanged(fixture);
  });

  it('rejects an impersonation JWT through the account-session guard', async () => {
    const fixture = await createFixture();
    const impersonationToken = jwt.sign({
      sub: fixture.actorId,
      email: 'impersonated@example.test',
      act: 'admin-actor',
    });
    const response = await gql(impersonationToken, {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    });
    expect(response.errors?.[0]?.message).toBe('Account session required');
    await expectUnchanged(fixture);
  });

  it('makes a repeated move safe', async () => {
    const fixture = await createFixture();
    const variables = {
      checkId: fixture.checkId,
      destinationProjectId: fixture.destinationProjectId,
    };
    const first = await gql(fixture.actorToken, variables);
    const second = await gql(fixture.actorToken, variables);
    expect(first.errors).toBeUndefined();
    expect(second.errors?.[0]?.message).toContain(
      'already in the destination project',
    );
    expect(await prisma.check.count({ where: { id: fixture.checkId } })).toBe(
      1,
    );
  });

  it('serializes concurrent moves so both eligible transitions succeed without duplicating history', async () => {
    const fixture = await createFixture();
    const secondCreatorEmail = email('concurrent-destination-creator');
    const secondDestination = await prisma.$transaction(async (tx) => {
      const creator = await tx.user.create({
        data: { email: secondCreatorEmail },
      });
      const organization = await tx.organization.create({
        data: {
          name: `Concurrent destination ${runId}`,
          slug: `concurrent-destination-${runId}-${sequence++}`,
          creatorUserId: creator.id,
        },
      });
      await tx.membership.createMany({
        data: [
          {
            userId: creator.id,
            organizationId: organization.id,
            role: 'OWNER',
          },
          {
            userId: fixture.actorId,
            organizationId: organization.id,
            role: 'OWNER',
          },
        ],
      });
      const project = await tx.project.create({
        data: {
          name: 'Concurrent destination',
          slug: `concurrent-${runId}-${sequence++}`,
          organizationId: organization.id,
        },
      });
      const statusPage = await tx.statusPage.create({
        data: {
          projectId: project.id,
          slug: `concurrent-page-${runId}-${sequence++}`,
          title: 'Concurrent destination',
          checkIds: [],
        },
      });
      return { project, statusPage };
    });

    const responses = await Promise.all([
      gql(fixture.actorToken, {
        checkId: fixture.checkId,
        destinationProjectId: fixture.destinationProjectId,
      }),
      gql(fixture.actorToken, {
        checkId: fixture.checkId,
        destinationProjectId: secondDestination.project.id,
      }),
    ]);
    expect(responses[0].errors).toBeUndefined();
    expect(responses[0].data?.moveCheck).toMatchObject({
      id: fixture.checkId,
      projectId: fixture.destinationProjectId,
    });
    expect(responses[1].errors).toBeUndefined();
    expect(responses[1].data?.moveCheck).toMatchObject({
      id: fixture.checkId,
      projectId: secondDestination.project.id,
    });
    const [
      check,
      eventCount,
      alertCount,
      sourcePages,
      destinationPage,
      secondDestinationPage,
    ] = await Promise.all([
      prisma.check.findUniqueOrThrow({ where: { id: fixture.checkId } }),
      prisma.checkEvent.count({ where: { checkId: fixture.checkId } }),
      prisma.alertLog.count({ where: { checkId: fixture.checkId } }),
      prisma.statusPage.findMany({
        where: { id: { in: fixture.sourcePageIds } },
      }),
      prisma.statusPage.findUniqueOrThrow({
        where: { id: fixture.destinationPageId },
      }),
      prisma.statusPage.findUniqueOrThrow({
        where: { id: secondDestination.statusPage.id },
      }),
    ]);
    expect([
      fixture.destinationProjectId,
      secondDestination.project.id,
    ]).toContain(check.projectId);
    expect(await prisma.check.count({ where: { id: fixture.checkId } })).toBe(
      1,
    );
    expect([eventCount, alertCount]).toEqual([1, 1]);
    expect(
      sourcePages.every((page) => !page.checkIds.includes(fixture.checkId)),
    ).toBe(true);
    expect(destinationPage.checkIds).toEqual(fixture.destinationPageCheckIds);
    expect(secondDestinationPage.checkIds).toEqual([]);
  });
});
