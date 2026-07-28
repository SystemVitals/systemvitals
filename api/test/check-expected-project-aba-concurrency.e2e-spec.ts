import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@systemvitals/database';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { ChecksService } from '../src/checks/checks.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const TIMEOUT_MS = 8_000;
const sourceUrl = process.env.DATABASE_URL ?? '';
if (!sourceUrl) throw new Error('DATABASE_URL is required');

jest.setTimeout(30_000);

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

function client(applicationName: string): PrismaClient {
  const url = new URL(sourceUrl);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', applicationName);
  return new PrismaClient({ datasourceUrl: url.toString() });
}

function checksService(prisma: PrismaClient): ChecksService {
  const service = prisma as unknown as PrismaService;
  return new ChecksService(service, new AccountEntitlementsService(service));
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForLock(
  observer: PrismaClient,
  applicationName: string,
  stop?: Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<
      Array<{ waitEventType: string | null }>
    >`
      SELECT wait_event_type AS "waitEventType"
      FROM pg_stat_activity
      WHERE application_name = ${applicationName}
        AND state = 'active'
    `;
    if (rows.some(({ waitEventType }) => waitEventType === 'Lock')) return true;
    const stopped = await Promise.race([
      new Promise<false>((resolveDelay) =>
        setTimeout(() => resolveDelay(false), 10),
      ),
      stop?.then(() => true as const) ?? new Promise<true>(() => undefined),
    ]);
    if (stopped) return false;
  }
  throw new Error(`${applicationName} did not contend on a lock`);
}

async function holdCheckRow(
  prisma: PrismaClient,
  checkId: string,
  acquired: Deferred,
  release: Deferred,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM checks WHERE id = ${checkId} FOR UPDATE
      `;
      acquired.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

describe('expected-project ABA protection on PostgreSQL', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const actingOwnerId = `check-aba-owner-a-${suffix}`;
  const expectedCreatorId = `check-aba-owner-b-${suffix}`;
  const intermediateOrganizationId = `check-aba-org-a-${suffix}`;
  const expectedOrganizationId = `check-aba-org-b-${suffix}`;
  const intermediateProjectId = `check-aba-project-a-${suffix}`;
  const expectedProjectId = `check-aba-project-b-${suffix}`;
  const checkId = `check-aba-check-${suffix}`;
  const names = {
    setup: `check-aba-setup-${suffix}`,
    blocker: `check-aba-blocker-${suffix}`,
    move: `check-aba-return-move-${suffix}`,
    pause: `check-aba-pause-${suffix}`,
    observer: `check-aba-observer-${suffix}`,
  };

  it('rejects a mutation that initially observes the intermediate project during D-to-S-to-D moves', async () => {
    const setup = client(names.setup);
    const blocker = client(names.blocker);
    const move = client(names.move);
    const pause = client(names.pause);
    const observer = client(names.observer);
    const blockerAcquired = deferred();
    const releaseBlocker = deferred();
    const stopPauseObservation = deferred();
    let blockerRun: Promise<void> | undefined;
    let moveRun: ReturnType<ChecksService['move']> | undefined;
    let pauseRun: ReturnType<ChecksService['pause']> | undefined;
    let pauseBlocked: Promise<boolean> | undefined;

    try {
      await setup.$transaction(async (tx) => {
        await tx.user.createMany({
          data: [
            {
              id: actingOwnerId,
              email: `check-aba-a+${suffix}@example.test`,
            },
            {
              id: expectedCreatorId,
              email: `check-aba-b+${suffix}@example.test`,
            },
          ],
        });
        await tx.organization.createMany({
          data: [
            {
              id: intermediateOrganizationId,
              name: 'ABA intermediate organization',
              slug: `check-aba-org-a-${suffix}`,
              creatorUserId: actingOwnerId,
            },
            {
              id: expectedOrganizationId,
              name: 'ABA expected organization',
              slug: `check-aba-org-b-${suffix}`,
              creatorUserId: expectedCreatorId,
            },
          ],
        });
        await tx.membership.createMany({
          data: [
            {
              userId: actingOwnerId,
              organizationId: intermediateOrganizationId,
              role: 'OWNER',
            },
            {
              userId: actingOwnerId,
              organizationId: expectedOrganizationId,
              role: 'OWNER',
            },
            {
              userId: expectedCreatorId,
              organizationId: expectedOrganizationId,
              role: 'OWNER',
            },
          ],
        });
        await tx.project.createMany({
          data: [
            {
              id: intermediateProjectId,
              name: 'ABA intermediate project',
              slug: `check-aba-project-a-${suffix}`,
              organizationId: intermediateOrganizationId,
            },
            {
              id: expectedProjectId,
              name: 'ABA expected project',
              slug: `check-aba-project-b-${suffix}`,
              organizationId: expectedOrganizationId,
            },
          ],
        });
        await tx.check.create({
          data: {
            id: checkId,
            name: 'ABA check',
            slug: `check-aba-check-${suffix}`,
            type: 'HEARTBEAT',
            status: 'NEW',
            projectId: expectedProjectId,
            pingSlug: randomUUID(),
            periodSeconds: 300,
            graceSeconds: 30,
          },
        });
      });

      await checksService(setup).move(
        actingOwnerId,
        checkId,
        intermediateProjectId,
      );

      blockerRun = holdCheckRow(
        blocker,
        checkId,
        blockerAcquired,
        releaseBlocker,
      );
      void blockerRun.catch(() => undefined);
      await bounded(blockerAcquired.promise, 'check-row blocker');

      moveRun = checksService(move).move(
        actingOwnerId,
        checkId,
        expectedProjectId,
      );
      void moveRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, names.move),
        'return move check-row contention',
      );

      pauseRun = checksService(pause).pause(
        actingOwnerId,
        checkId,
        expectedProjectId,
      );
      void pauseRun.catch(() => undefined);
      pauseBlocked = waitForLock(
        observer,
        names.pause,
        stopPauseObservation.promise,
      );
      void pauseBlocked.catch(() => undefined);
      const earlyPause = await bounded(
        Promise.race([
          pauseRun.then(
            () => ({ status: 'fulfilled' as const }),
            (reason: unknown) => ({ status: 'rejected' as const, reason }),
          ),
          pauseBlocked.then((blocked) => ({
            status: blocked
              ? ('blocked' as const)
              : ('observation-stopped' as const),
          })),
        ]),
        'intermediate-project mutation decision',
      );
      stopPauseObservation.resolve();
      await pauseBlocked;

      expect(earlyPause.status).toBe('rejected');
      if (earlyPause.status === 'rejected') {
        expect(earlyPause.reason).toBeInstanceOf(ForbiddenException);
        expect((earlyPause.reason as Error).message).toMatch(
          /authorized project/i,
        );
      }

      releaseBlocker.resolve();
      const [blockerResult, moveResult, pauseResult] = await bounded(
        Promise.allSettled([blockerRun, moveRun, pauseRun]),
        'expected-project ABA race',
      );

      expect(blockerResult).toEqual({
        status: 'fulfilled',
        value: undefined,
      });
      expect(moveResult.status).toBe('fulfilled');
      expect(pauseResult.status).toBe('rejected');
      expect(
        await setup.check.findUniqueOrThrow({
          where: { id: checkId },
          select: { projectId: true, status: true },
        }),
      ).toEqual({ projectId: expectedProjectId, status: 'NEW' });
    } finally {
      releaseBlocker.resolve();
      stopPauseObservation.resolve();
      await Promise.allSettled(
        [blockerRun, moveRun, pauseRun, pauseBlocked].filter(
          (operation) => operation !== undefined,
        ),
      );
      await setup.organization.deleteMany({
        where: {
          id: { in: [intermediateOrganizationId, expectedOrganizationId] },
        },
      });
      await setup.user.deleteMany({
        where: { id: { in: [actingOwnerId, expectedCreatorId] } },
      });
      await Promise.allSettled(
        [setup, blocker, move, pause, observer].map((connection) =>
          connection.$disconnect(),
        ),
      );
    }
  });
});
