import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from '../src/app.module';
import {
  AlertQueueService,
  type AlertJobData,
} from '../src/queue/alert-queue.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { cleanupTestUsers } from './cleanup-test-users';

jest.setTimeout(60_000);

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

interface Fixture {
  ownerToken: string;
  checkId: string;
  pingSlug: string;
  channelIds: [string, string];
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ping recovery snapshots (e2e)', () => {
  const runId = randomUUID().replaceAll('-', '').slice(0, 12);
  const fixtureEmails: string[] = [];
  const enqueue = jest.fn<Promise<void>, [AlertJobData]>();
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
    enqueue.mockReset();
    enqueue.mockResolvedValue();
  });

  async function createFixture(
    excludedChannelIndexes: number[] = [],
  ): Promise<Fixture> {
    const label = `${runId}-${sequence++}`;
    const email = `ping-recovery-${label}@example.test`;
    fixtureEmails.push(email);

    return prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({ data: { email } });
      const organization = await tx.organization.create({
        data: {
          name: `Ping recovery ${label}`,
          slug: `ping-recovery-${label}`,
          creatorUserId: owner.id,
        },
      });
      await tx.membership.create({
        data: {
          userId: owner.id,
          organizationId: organization.id,
          role: 'OWNER',
        },
      });
      const project = await tx.project.create({
        data: {
          name: 'Recovery snapshots',
          slug: `recovery-${label}`,
          organizationId: organization.id,
        },
      });
      const pingSlug = randomUUID();
      const check = await tx.check.create({
        data: {
          name: 'Heartbeat recovery',
          slug: `heartbeat-${label}`,
          type: 'HEARTBEAT',
          status: 'DOWN',
          projectId: project.id,
          pingSlug,
          periodSeconds: 300,
          graceSeconds: 30,
        },
      });
      const channels = await Promise.all([
        tx.notificationChannel.create({
          data: {
            projectId: project.id,
            type: 'WEBHOOK',
            destinationKey: `early-${label}`,
            config: { url: 'https://example.test/early' },
            enabled: true,
            createdAt: new Date('2025-01-01T00:00:00.000Z'),
          },
        }),
        tx.notificationChannel.create({
          data: {
            projectId: project.id,
            type: 'WEBHOOK',
            destinationKey: `late-${label}`,
            config: { url: 'https://example.test/late' },
            enabled: true,
            createdAt: new Date('2025-01-02T00:00:00.000Z'),
          },
        }),
      ]);
      if (excludedChannelIndexes.length > 0) {
        await tx.checkChannelExclusion.createMany({
          data: excludedChannelIndexes.map((index) => ({
            checkId: check.id,
            channelId: channels[index].id,
          })),
        });
      }

      return {
        ownerToken: jwt.sign({ sub: owner.id, email: owner.email }),
        checkId: check.id,
        pingSlug,
        channelIds: [channels[0].id, channels[1].id],
      };
    });
  }

  async function ping(pingSlug: string) {
    return app.inject({ method: 'GET', url: `/ping/${pingSlug}` });
  }

  async function setChannelEnabled(
    fixture: Fixture,
    channelId: string,
    enabled: boolean,
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/graphql',
      headers: { authorization: `Bearer ${fixture.ownerToken}` },
      payload: {
        query: SET_CHANNEL_ENABLED,
        variables: {
          checkId: fixture.checkId,
          channelId,
          enabled,
        },
      },
    });
    const body = JSON.parse(response.body) as {
      errors?: Array<{ message: string }>;
    };
    expect(body.errors).toBeUndefined();
  }

  async function waitForBlockedPingLocks(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;

    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::int AS count
        FROM pg_stat_activity
        WHERE pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%SELECT id FROM checks%'
          AND query ILIKE '%FOR UPDATE%'
      `;
      if ((rows[0]?.count ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    throw new Error(`Timed out waiting for ${count} blocked heartbeat pings`);
  }

  it('enqueues the exact effective channel snapshot for a recovery', async () => {
    const fixture = await createFixture([1]);

    const response = await ping(fixture.pingSlug);

    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith({
      checkId: fixture.checkId,
      kind: 'recovery',
      channelIds: [fixture.channelIds[0]],
    });
  });

  it('enqueues an empty snapshot when every channel is excluded', async () => {
    const fixture = await createFixture([0, 1]);

    const response = await ping(fixture.pingSlug);

    expect(response.statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledWith({
      checkId: fixture.checkId,
      kind: 'recovery',
      channelIds: [],
    });
  });

  it('does not enqueue a later ping after the recovery transition', async () => {
    const fixture = await createFixture();
    expect((await ping(fixture.pingSlug)).statusCode).toBe(200);
    enqueue.mockClear();

    const response = await ping(fixture.pingSlug);

    expect(response.statusCode).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('retains selected-at-transition recipients after a later exclusion', async () => {
    const fixture = await createFixture();
    expect((await ping(fixture.pingSlug)).statusCode).toBe(200);
    const queuedJob = enqueue.mock.calls[0][0];

    await setChannelEnabled(fixture, fixture.channelIds[0], false);

    expect(queuedJob.channelIds).toEqual(fixture.channelIds);
  });

  it('retains an empty transition snapshot after a later enable', async () => {
    const fixture = await createFixture([0, 1]);
    expect((await ping(fixture.pingSlug)).statusCode).toBe(200);
    const queuedJob = enqueue.mock.calls[0][0];

    await setChannelEnabled(fixture, fixture.channelIds[0], true);

    expect(queuedJob.channelIds).toEqual([]);
  });

  it('serializes concurrent pings and enqueues recovery at most once', async () => {
    const fixture = await createFixture();
    const blockerHasCheckLock = deferred();
    const releaseBlocker = deferred();
    const blockerPromise = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM checks WHERE id = ${fixture.checkId} FOR UPDATE
      `;
      blockerHasCheckLock.resolve();
      await releaseBlocker.promise;
    });
    let pingPromises: Array<ReturnType<typeof ping>> = [];

    try {
      await blockerHasCheckLock.promise;
      pingPromises = [ping(fixture.pingSlug), ping(fixture.pingSlug)];
      await waitForBlockedPingLocks(2);
      releaseBlocker.resolve();
      const responses = await Promise.all(pingPromises);

      expect(responses.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith({
        checkId: fixture.checkId,
        kind: 'recovery',
        channelIds: fixture.channelIds,
      });
    } finally {
      releaseBlocker.resolve();
      await blockerPromise.catch(() => undefined);
      await Promise.all(
        pingPromises.map((request) => request.catch(() => undefined)),
      );
    }
  });
});
