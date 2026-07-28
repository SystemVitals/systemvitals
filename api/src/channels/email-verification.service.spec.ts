/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Jest mock call metadata and asymmetric matchers are typed as any. */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@systemvitals/database';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailVerificationQueueService } from '../queue/email-verification-queue.service';
import {
  createEmailVerificationToken,
  hashEmailVerificationToken,
} from './email-verification-token';
import { EmailVerificationService } from './email-verification.service';

const NOW = new Date('2032-03-04T05:06:07.000Z');
const TOKEN = createEmailVerificationToken(NOW).rawToken;

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function pendingChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-1',
    projectId: 'project-1',
    type: 'EMAIL',
    config: { email: 'alerts@example.com' },
    enabled: false,
    verifiedAt: null,
    verificationTokenHash: hashEmailVerificationToken(TOKEN),
    verificationExpiresAt: new Date('2032-03-05T05:06:07.000Z'),
    verificationSentAt: null,
    project: {
      name: 'Production',
      organizationId: 'organization-1',
    },
    ...overrides,
  };
}

function makeService() {
  const notificationChannel = {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  };
  const membership = { findUnique: jest.fn() };
  const queryRaw = jest.fn().mockResolvedValue([{ id: 'channel-1' }]);
  const tx = {
    notificationChannel,
    membership,
    $queryRaw: queryRaw,
  };
  const transaction = jest.fn(
    async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  );
  const prisma = {
    notificationChannel,
    $transaction: transaction,
  } as unknown as PrismaService;
  const queue = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailVerificationQueueService;

  return {
    service: new EmailVerificationService(prisma, queue),
    notificationChannel,
    membership,
    queryRaw,
    queue: queue as unknown as { enqueue: jest.Mock },
  };
}

describe('EmailVerificationService preview', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns a masked pending preview without mutating the channel', async () => {
    const { service, notificationChannel } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());

    await expect(service.preview(TOKEN)).resolves.toEqual({
      status: 'PENDING',
      maskedEmail: 'a•••••@example.com',
      projectName: 'Production',
      expiresAt: new Date('2032-03-05T05:06:07.000Z'),
    });
    expect(notificationChannel.update).not.toHaveBeenCalled();
    expect(notificationChannel.updateMany).not.toHaveBeenCalled();
  });

  it('returns EXPIRED for the matching expired pending token', async () => {
    const { service, notificationChannel } = makeService();
    notificationChannel.findUnique.mockResolvedValue(
      pendingChannel({
        verificationExpiresAt: new Date('2032-03-04T05:06:06.999Z'),
      }),
    );

    await expect(service.preview(TOKEN)).resolves.toEqual({
      status: 'EXPIRED',
    });
  });

  it.each([
    ['malformed', 'not-a-token', undefined],
    ['missing or replaced', TOKEN, null],
    ['consumed', TOKEN, pendingChannel({ verifiedAt: NOW })],
  ])('returns INVALID for a %s token', async (_case, token, channel) => {
    const { service, notificationChannel } = makeService();
    notificationChannel.findUnique.mockResolvedValue(channel);

    await expect(service.preview(token)).resolves.toEqual({
      status: 'INVALID',
    });
  });
});

describe('EmailVerificationService verify', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('atomically enables a current token once and clears its secret metadata', async () => {
    const { service, notificationChannel, queryRaw } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());
    notificationChannel.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.verify(TOKEN)).resolves.toEqual({
      status: 'VERIFIED',
      maskedEmail: 'a•••••@example.com',
      projectName: 'Production',
    });
    expect(notificationChannel.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'channel-1',
        verificationTokenHash: hashEmailVerificationToken(TOKEN),
        verifiedAt: null,
      },
      data: {
        enabled: true,
        verifiedAt: NOW,
        verificationTokenHash: null,
        verificationExpiresAt: null,
      },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      notificationChannel.findUnique.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it('returns generic INVALID when another transaction consumed the token', async () => {
    const { service, notificationChannel } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());
    notificationChannel.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.verify(TOKEN)).resolves.toEqual({
      status: 'INVALID',
    });
  });
});

describe('EmailVerificationService resend', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns identical outward errors for nonexistent and unauthorized channel IDs', async () => {
    const missing = makeService();
    missing.queryRaw.mockResolvedValue([]);

    const unauthorized = makeService();
    unauthorized.notificationChannel.findUnique.mockResolvedValue(
      pendingChannel(),
    );
    unauthorized.membership.findUnique.mockResolvedValue(null);

    const capture = async (service: EmailVerificationService) => {
      try {
        await service.resend('user-2', 'channel-1');
        throw new Error('Expected resend to reject');
      } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        return {
          status: error.getStatus(),
          response: error.getResponse(),
        };
      }
    };

    const [missingError, unauthorizedError] = await Promise.all([
      capture(missing.service),
      capture(unauthorized.service),
    ]);

    expect(missingError).toEqual(unauthorizedError);
  });

  it('rejects a caller without project membership', async () => {
    const { service, notificationChannel, membership } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());
    membership.findUnique.mockResolvedValue(null);

    await expect(service.resend('user-2', 'channel-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it.each([
    ['non-email', { type: 'SLACK' }, BadRequestException],
    ['verified', { verifiedAt: NOW }, BadRequestException],
  ])('rejects a %s channel', async (_case, override, exception) => {
    const { service, notificationChannel, membership } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel(override));
    membership.findUnique.mockResolvedValue({ id: 'membership-1' });

    await expect(service.resend('user-1', 'channel-1')).rejects.toBeInstanceOf(
      exception,
    );
  });

  it('enforces the 60 second cooldown without rotating the token', async () => {
    const { service, notificationChannel, membership } = makeService();
    notificationChannel.findUnique.mockResolvedValue(
      pendingChannel({
        verificationSentAt: new Date('2032-03-04T05:05:08.000Z'),
      }),
    );
    membership.findUnique.mockResolvedValue({ id: 'membership-1' });

    await expect(service.resend('user-1', 'channel-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(notificationChannel.update).not.toHaveBeenCalled();
  });

  it('locks the row, reserves the cooldown, and acknowledges only its reservation', async () => {
    const { service, notificationChannel, membership, queryRaw, queue } =
      makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());
    membership.findUnique.mockResolvedValue({ id: 'membership-1' });
    notificationChannel.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          ...pendingChannel(),
          ...data,
        }),
    );
    notificationChannel.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.resend('user-1', 'channel-1');

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(String(queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE');
    const rotated = notificationChannel.update.mock.calls[0]?.[0].data as {
      verificationTokenHash: string;
      verificationExpiresAt: Date;
      verificationSentAt: Date;
    };
    expect(rotated).toEqual(
      expect.objectContaining({
        verificationTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        verificationExpiresAt: new Date('2032-03-05T05:06:07.000Z'),
        verificationSentAt: NOW,
      }),
    );
    expect(rotated.verificationTokenHash).not.toBe(
      hashEmailVerificationToken(TOKEN),
    );
    const rawToken = queue.enqueue.mock.calls[0]?.[0].rawToken as string;
    expect(hashEmailVerificationToken(rawToken)).toBe(
      rotated.verificationTokenHash,
    );
    expect(notificationChannel.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'channel-1',
        verificationTokenHash: rotated.verificationTokenHash,
        verificationSentAt: NOW,
      },
      data: { verificationSentAt: NOW },
    });
    expect(result).toEqual(
      expect.objectContaining({
        verificationStatus: 'PENDING',
        verificationDeliveryStatus: 'SENT',
      }),
    );
  });

  it('clears only its reservation and returns NOT_SENT when enqueue fails', async () => {
    const { service, notificationChannel, membership, queue } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());
    membership.findUnique.mockResolvedValue({ id: 'membership-1' });
    notificationChannel.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...pendingChannel(), ...data }),
    );
    notificationChannel.updateMany.mockResolvedValue({ count: 1 });
    queue.enqueue.mockRejectedValue(new Error('queue unavailable'));

    await expect(service.resend('user-1', 'channel-1')).resolves.toEqual(
      expect.objectContaining({
        verificationDeliveryStatus: 'NOT_SENT',
      }),
    );
    const rotated = notificationChannel.update.mock.calls[0]?.[0].data as {
      verificationTokenHash: string;
    };
    expect(notificationChannel.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'channel-1',
        verificationTokenHash: rotated.verificationTokenHash,
        verificationSentAt: NOW,
      },
      data: { verificationSentAt: null },
    });
  });

  it('rejects a stale success acknowledgment that cannot mark a newer reservation sent', async () => {
    const { service, notificationChannel, membership } = makeService();
    notificationChannel.findUnique.mockResolvedValue(pendingChannel());
    membership.findUnique.mockResolvedValue({ id: 'membership-1' });
    notificationChannel.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...pendingChannel(), ...data }),
    );
    notificationChannel.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.resend('user-1', 'channel-1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('does not clear a newer reservation after a stale enqueue failure', async () => {
    const { service, notificationChannel, membership, queue } = makeService();
    notificationChannel.findUnique
      .mockResolvedValueOnce(pendingChannel())
      .mockResolvedValueOnce(
        pendingChannel({
          verificationTokenHash: 'newer-hash',
          verificationSentAt: new Date(NOW.getTime() + 1),
        }),
      );
    membership.findUnique.mockResolvedValue({ id: 'membership-1' });
    notificationChannel.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...pendingChannel(), ...data }),
    );
    notificationChannel.updateMany.mockResolvedValue({ count: 0 });
    queue.enqueue.mockRejectedValue(new Error('stale queue failure'));

    await expect(service.resend('user-1', 'channel-1')).resolves.toEqual(
      expect.objectContaining({
        verificationDeliveryStatus: 'SENT',
      }),
    );
    expect(notificationChannel.findUnique).toHaveBeenCalledTimes(2);
  });
});

const databaseAvailable = Boolean(process.env['DATABASE_URL']);
const describePostgres = databaseAvailable ? describe : describe.skip;

describePostgres(
  databaseAvailable
    ? 'EmailVerificationService PostgreSQL expiry concurrency'
    : 'EmailVerificationService PostgreSQL expiry concurrency (skipped: DATABASE_URL unavailable)',
  () => {
    jest.setTimeout(15_000);

    it('does not enable a channel that expires while verification waits on its row lock', async () => {
      const databaseUrl = new URL(process.env['DATABASE_URL'] as string);
      const verifierApplicationName = `email-verify-${randomUUID()}`;
      databaseUrl.searchParams.set('application_name', verifierApplicationName);
      const prisma = new PrismaClient();
      const locker = new PrismaClient();
      const verifier = new PrismaClient({
        datasourceUrl: databaseUrl.toString(),
      });
      const suffix = randomUUID();
      const userId = `verify-user-${suffix}`;
      const organizationId = `verify-org-${suffix}`;
      const projectId = `verify-project-${suffix}`;
      const channelId = `verify-channel-${suffix}`;
      const token = createEmailVerificationToken().rawToken;
      const lockAcquired = deferred();
      const releaseLock = deferred();
      let lockTransaction: Promise<void> | undefined;
      const expiresAt = new Date(Date.now() + 2_000);

      try {
        await prisma.user.create({
          data: {
            id: userId,
            email: `verify-${suffix}@example.com`,
          },
        });
        await prisma.organization.create({
          data: {
            id: organizationId,
            name: `Verification ${suffix}`,
            slug: `verify-${suffix}`,
            creatorUserId: userId,
          },
        });
        await prisma.project.create({
          data: {
            id: projectId,
            name: 'Expiry race',
            slug: 'expiry-race',
            organizationId,
          },
        });
        await prisma.notificationChannel.create({
          data: {
            id: channelId,
            projectId,
            type: 'EMAIL',
            config: { email: 'alerts@example.com' },
            enabled: false,
            verifiedAt: null,
            verificationTokenHash: hashEmailVerificationToken(token),
            verificationExpiresAt: expiresAt,
            verificationSentAt: null,
          },
        });

        lockTransaction = locker.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM "notification_channels"
              WHERE "id" = ${channelId}
              FOR UPDATE
            `;
            lockAcquired.resolve();
            await releaseLock.promise;
          },
          { timeout: 10_000 },
        );
        await lockAcquired.promise;

        const queue = {
          enqueue: jest.fn(),
        } as unknown as EmailVerificationQueueService;
        const service = new EmailVerificationService(
          verifier as unknown as PrismaService,
          queue,
        );
        const verification = service.verify(token);

        const waitDeadline = Date.now() + 5_000;
        let blocked = false;
        while (!blocked && Date.now() < waitDeadline) {
          const rows = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM "pg_stat_activity"
              WHERE "application_name" = ${verifierApplicationName}
                AND "wait_event_type" = 'Lock'
            ) AS "blocked"
          `;
          blocked = rows[0]?.blocked ?? false;
          if (!blocked) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        expect(blocked).toBe(true);

        const untilExpired = expiresAt.getTime() - Date.now() + 100;
        if (untilExpired > 0) {
          await new Promise((resolve) => setTimeout(resolve, untilExpired));
        }
        releaseLock.resolve();

        await expect(verification).resolves.toEqual({ status: 'EXPIRED' });
        await expect(
          prisma.notificationChannel.findUniqueOrThrow({
            where: { id: channelId },
            select: { enabled: true, verifiedAt: true },
          }),
        ).resolves.toEqual({ enabled: false, verifiedAt: null });
      } finally {
        releaseLock.resolve();
        try {
          await lockTransaction;
          await prisma.organization.deleteMany({
            where: { id: organizationId },
          });
          await prisma.user.deleteMany({ where: { id: userId } });
        } finally {
          await Promise.all([
            prisma.$disconnect(),
            locker.$disconnect(),
            verifier.$disconnect(),
          ]);
        }
      }
    });

    it('allows exactly one of two simultaneous resends to enqueue', async () => {
      const prisma = new PrismaClient();
      const suffix = randomUUID();
      const lockerApplicationName = `email-resend-locker-${suffix}`;
      const firstApplicationName = `email-resend-first-${suffix}`;
      const secondApplicationName = `email-resend-second-${suffix}`;
      const clientFor = (applicationName: string) => {
        const databaseUrl = new URL(process.env['DATABASE_URL'] as string);
        databaseUrl.searchParams.set('application_name', applicationName);
        return new PrismaClient({ datasourceUrl: databaseUrl.toString() });
      };
      const locker = clientFor(lockerApplicationName);
      const firstClient = clientFor(firstApplicationName);
      const secondClient = clientFor(secondApplicationName);
      const userId = `resend-user-${suffix}`;
      const organizationId = `resend-org-${suffix}`;
      const projectId = `resend-project-${suffix}`;
      const channelId = `resend-channel-${suffix}`;
      const lockAcquired = deferred();
      const releaseLock = deferred();
      let lockTransaction: Promise<void> | undefined;
      let resends: Promise<Array<PromiseSettledResult<unknown>>> | undefined;

      try {
        await prisma.user.create({
          data: { id: userId, email: `resend-${suffix}@example.com` },
        });
        await prisma.organization.create({
          data: {
            id: organizationId,
            name: `Resend ${suffix}`,
            slug: `resend-${suffix}`,
            creatorUserId: userId,
          },
        });
        await prisma.membership.create({
          data: { userId, organizationId, role: 'OWNER' },
        });
        await prisma.project.create({
          data: {
            id: projectId,
            name: 'Resend race',
            slug: 'resend-race',
            organizationId,
          },
        });
        await prisma.notificationChannel.create({
          data: {
            id: channelId,
            projectId,
            type: 'EMAIL',
            config: { email: 'race@example.com' },
            enabled: false,
            verifiedAt: null,
            verificationTokenHash: hashEmailVerificationToken(TOKEN),
            verificationExpiresAt: new Date(Date.now() + 60_000),
            verificationSentAt: null,
          },
        });

        lockTransaction = locker.$transaction(
          async (tx) => {
            await tx.$queryRaw`
              SELECT "id" FROM "notification_channels"
              WHERE "id" = ${channelId}
              FOR UPDATE
            `;
            lockAcquired.resolve();
            await releaseLock.promise;
          },
          { timeout: 10_000 },
        );
        await lockAcquired.promise;

        const enqueue = jest.fn().mockResolvedValue(undefined);
        const queue = { enqueue } as unknown as EmailVerificationQueueService;
        const services = [
          new EmailVerificationService(
            firstClient as unknown as PrismaService,
            queue,
          ),
          new EmailVerificationService(
            secondClient as unknown as PrismaService,
            queue,
          ),
        ];

        resends = Promise.allSettled([
          services[0].resend(userId, channelId),
          services[1].resend(userId, channelId),
        ]);

        const waitDeadline = Date.now() + 5_000;
        let waitingApplications: string[] = [];
        while (waitingApplications.length < 2 && Date.now() < waitDeadline) {
          const waiting = await prisma.$queryRaw<
            Array<{ applicationName: string }>
          >`
            WITH RECURSIVE "blocking_chain" AS (
              SELECT
                "activity"."pid" AS "waiting_pid",
                unnest(pg_blocking_pids("activity"."pid")) AS "blocker_pid"
              FROM "pg_stat_activity" AS "activity"
              WHERE "activity"."application_name" IN (
                ${firstApplicationName},
                ${secondApplicationName}
              )

              UNION

              SELECT
                "chain"."waiting_pid",
                unnest(pg_blocking_pids("chain"."blocker_pid"))
              FROM "blocking_chain" AS "chain"
            )
            SELECT DISTINCT
              "activity"."application_name" AS "applicationName"
            FROM "pg_stat_activity" AS "activity"
            WHERE "activity"."application_name" IN (
              ${firstApplicationName},
              ${secondApplicationName}
            )
              AND "activity"."wait_event_type" = 'Lock'
              AND EXISTS (
                SELECT 1
                FROM "pg_stat_activity" AS "blocker"
                WHERE "blocker"."application_name" = ${lockerApplicationName}
                  AND "blocker"."pid" IN (
                    SELECT "chain"."blocker_pid"
                    FROM "blocking_chain" AS "chain"
                    WHERE "chain"."waiting_pid" = "activity"."pid"
                  )
              )
          `;
          waitingApplications = waiting.map((row) => row.applicationName);
          if (waitingApplications.length < 2) {
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
        }
        expect(new Set(waitingApplications)).toEqual(
          new Set([firstApplicationName, secondApplicationName]),
        );

        releaseLock.resolve();
        const results = await resends;

        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const rejected = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        expect(rejected).toHaveLength(1);
        expect(rejected[0]?.reason).toBeInstanceOf(ConflictException);
        expect(enqueue).toHaveBeenCalledTimes(1);
      } finally {
        releaseLock.resolve();
        try {
          await Promise.allSettled([
            lockTransaction ?? Promise.resolve(),
            resends ?? Promise.resolve([]),
          ]);
          await prisma.notificationChannel.deleteMany({
            where: { id: channelId },
          });
          await prisma.project.deleteMany({ where: { id: projectId } });
          await prisma.membership.deleteMany({
            where: { userId, organizationId },
          });
          await prisma.organization.deleteMany({
            where: { id: organizationId },
          });
          await prisma.user.deleteMany({ where: { id: userId } });
        } finally {
          await Promise.all([
            prisma.$disconnect(),
            locker.$disconnect(),
            firstClient.$disconnect(),
            secondClient.$disconnect(),
          ]);
        }
      }
    });
  },
);
