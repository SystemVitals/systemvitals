import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@systemvitals/database';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { ChecksService } from '../src/checks/checks.service';
import { OrganizationsService } from '../src/organizations/organizations.service';
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

function organizationsService(prisma: PrismaClient): OrganizationsService {
  const service = prisma as unknown as PrismaService;
  return new OrganizationsService(
    service,
    new AccountEntitlementsService(service),
  );
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
): Promise<void> {
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
    if (rows.some(({ waitEventType }) => waitEventType === 'Lock')) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error(`${applicationName} did not contend on a lock`);
}

describe('check mutation and organization deletion lock order', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const ownerId = `check-org-delete-owner-${suffix}`;
  const targetOrganizationId = `check-org-delete-target-${suffix}`;
  const fallbackOrganizationId = `check-org-delete-fallback-${suffix}`;
  const projectId = `check-org-delete-project-${suffix}`;
  const checkId = `check-org-delete-check-${suffix}`;
  const functionName = `pause_check_org_delete_${suffix}`;
  const triggerName = `pause_check_org_delete_${suffix}`;
  const coordinationLock =
    1_000_000_000 + Number.parseInt(suffix.slice(0, 7), 16);
  const names = {
    setup: `check-org-delete-setup-${suffix}`,
    blocker: `check-org-delete-blocker-${suffix}`,
    deletion: `check-org-delete-deletion-${suffix}`,
    pause: `check-org-delete-pause-${suffix}`,
    observer: `check-org-delete-observer-${suffix}`,
  };

  it('serializes pause behind self-service organization deletion without a deadlock', async () => {
    const setup = client(names.setup);
    const blocker = client(names.blocker);
    const deletion = client(names.deletion);
    const pause = client(names.pause);
    const observer = client(names.observer);
    const blockerAcquired = deferred();
    const releaseBlocker = deferred();
    let functionCreated = false;
    let triggerCreated = false;
    let blockerRun: Promise<void> | undefined;
    let deleteRun: Promise<boolean> | undefined;
    let pauseRun: ReturnType<ChecksService['pause']> | undefined;

    try {
      await setup.$transaction(async (tx) => {
        const owner = await tx.user.create({
          data: {
            id: ownerId,
            email: `check-org-delete+${suffix}@example.test`,
          },
        });
        await tx.organization.createMany({
          data: [
            {
              id: targetOrganizationId,
              name: 'Organization being deleted',
              slug: `check-org-delete-target-${suffix}`,
              creatorUserId: owner.id,
            },
            {
              id: fallbackOrganizationId,
              name: 'Fallback organization',
              slug: `check-org-delete-fallback-${suffix}`,
              creatorUserId: owner.id,
            },
          ],
        });
        await tx.membership.createMany({
          data: [
            {
              userId: owner.id,
              organizationId: targetOrganizationId,
              role: 'OWNER',
            },
            {
              userId: owner.id,
              organizationId: fallbackOrganizationId,
              role: 'OWNER',
            },
          ],
        });
        await tx.project.create({
          data: {
            id: projectId,
            name: 'Project being deleted',
            slug: `check-org-delete-project-${suffix}`,
            organizationId: targetOrganizationId,
          },
        });
        await tx.check.create({
          data: {
            id: checkId,
            name: 'Check being paused',
            slug: `check-org-delete-check-${suffix}`,
            type: 'HEARTBEAT',
            status: 'NEW',
            projectId,
            pingSlug: randomUUID(),
            periodSeconds: 300,
            graceSeconds: 30,
          },
        });
      });

      await setup.$executeRawUnsafe(`
        CREATE FUNCTION ${functionName}()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF OLD.id = '${targetOrganizationId}' THEN
            PERFORM pg_advisory_xact_lock(${coordinationLock});
          END IF;
          RETURN OLD;
        END;
        $function$
      `);
      functionCreated = true;
      await setup.$executeRawUnsafe(`
        CREATE TRIGGER ${triggerName}
        BEFORE DELETE ON organizations
        FOR EACH ROW
        EXECUTE FUNCTION ${functionName}()
      `);
      triggerCreated = true;

      blockerRun = blocker.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT CAST(
              pg_advisory_xact_lock(${coordinationLock})
              AS TEXT
            ) AS locked
          `;
          blockerAcquired.resolve();
          await releaseBlocker.promise;
        },
        { timeout: TIMEOUT_MS },
      );
      void blockerRun.catch(() => undefined);
      await bounded(blockerAcquired.promise, 'coordination lock acquisition');

      deleteRun = organizationsService(deletion).remove(
        ownerId,
        targetOrganizationId,
      );
      void deleteRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, names.deletion),
        'organization deletion trigger pause',
      );

      pauseRun = checksService(pause).pause(ownerId, checkId, projectId);
      void pauseRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, names.pause),
        'check pause lock contention',
      );

      releaseBlocker.resolve();
      const [blockerResult, deleteResult, pauseResult] = await bounded(
        Promise.allSettled([blockerRun, deleteRun, pauseRun]),
        'check pause/organization deletion race',
      );

      expect(blockerResult).toEqual({
        status: 'fulfilled',
        value: undefined,
      });
      expect(deleteResult).toEqual({ status: 'fulfilled', value: true });
      expect(pauseResult.status).toBe('rejected');
      if (pauseResult.status === 'rejected') {
        expect(
          pauseResult.reason instanceof NotFoundException ||
            pauseResult.reason instanceof ForbiddenException ||
            pauseResult.reason instanceof ConflictException,
        ).toBe(true);
      }
      expect(
        await setup.organization.findUnique({
          where: { id: targetOrganizationId },
        }),
      ).toBeNull();
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled(
        [blockerRun, deleteRun, pauseRun].filter(
          (operation) => operation !== undefined,
        ),
      );
      if (triggerCreated) {
        await setup.$executeRawUnsafe(
          `DROP TRIGGER IF EXISTS ${triggerName} ON organizations`,
        );
      }
      if (functionCreated) {
        await setup.$executeRawUnsafe(
          `DROP FUNCTION IF EXISTS ${functionName}()`,
        );
      }
      await setup.organization.deleteMany({
        where: { creatorUserId: ownerId },
      });
      await setup.user.deleteMany({ where: { id: ownerId } });
      await Promise.allSettled(
        [setup, blocker, deletion, pause, observer].map((connection) =>
          connection.$disconnect(),
        ),
      );
    }
  });
});
