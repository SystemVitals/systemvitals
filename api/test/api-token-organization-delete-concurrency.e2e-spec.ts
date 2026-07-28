import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@systemvitals/database';
import type { FastifyRequest } from 'fastify';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { OrganizationsService } from '../src/organizations/organizations.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import { ApiTokenStrategy } from '../src/tokens/api-token.strategy';
import { hashToken } from '../src/tokens/token.util';

const TIMEOUT_MS = 8_000;
const COORDINATION_LOCK = 72_401_337;
const MEMBER_ID = 'lock-order-token-member';
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL is required');

jest.setTimeout(45_000);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface ActivityRow {
  waitEventType: string | null;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const databaseDir = resolve(__dirname, '../../database');
const databaseName = `systemvitals_token_lock_${randomUUID().replaceAll('-', '')}`;
if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
  throw new Error(`Unsafe temporary database name: ${databaseName}`);
}
const adminUrl = new URL(sourceUrl);
adminUrl.search = '';
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
testUrl.searchParams.set('schema', 'public');

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return execFileSync(command, args, {
    cwd: databaseDir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function sql(statement: string): void {
  run('psql', [adminUrl.toString(), '-v', 'ON_ERROR_STOP=1', '-c', statement]);
}

function client(applicationName: string): PrismaClient {
  const url = new URL(testUrl);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('application_name', applicationName);
  return new PrismaClient({ datasourceUrl: url.toString() });
}

function bearer(value: string): FastifyRequest {
  return {
    headers: { authorization: `Bearer ${value}` },
  } as FastifyRequest;
}

function organizationsService(prisma: PrismaClient): OrganizationsService {
  const service = prisma as unknown as PrismaService;
  return new OrganizationsService(
    service,
    new AccountEntitlementsService(service),
  );
}

function apiTokenStrategy(prisma: PrismaClient): ApiTokenStrategy {
  return new ApiTokenStrategy(
    prisma as unknown as PrismaService,
    { verify: jest.fn() } as unknown as JwtService,
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
    const rows = await observer.$queryRaw<ActivityRow[]>`
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

describe('API-token authentication and organization deletion lock order', () => {
  beforeAll(() => {
    try {
      sql(`CREATE DATABASE "${databaseName}"`);
      run('npx', ['prisma', 'migrate', 'deploy'], {
        DATABASE_URL: testUrl.toString(),
      });
    } catch (error) {
      sql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      throw error;
    }
  }, 30_000);

  afterAll(() => {
    sql(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
  });

  it('keeps authentication live and unauthorized while its organization is deleted', async () => {
    const setup = client('token-lock-setup');
    const blocker = client('token-lock-blocker');
    const deletion = client('token-lock-deletion');
    const authentication = client('token-lock-authentication');
    const observer = client('token-lock-observer');
    const releaseBlocker = deferred();
    const blockerAcquired = deferred();
    let blockerRun: Promise<void> | undefined;
    let deleteRun: Promise<boolean> | undefined;
    let authenticateRun: ReturnType<ApiTokenStrategy['validate']> | undefined;

    try {
      // Force and pause at the reviewer-observed deletion state: the
      // organization transaction owns the member row, but has not reached the
      // project cascade yet. The trigger only coordinates the interleaving;
      // both competing operations still run their real service transactions.
      await setup.$executeRawUnsafe(`
        CREATE FUNCTION pause_organization_delete_after_membership_lock()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $function$
        BEGIN
          IF OLD.id = 'lock-order-deleted-organization' THEN
            PERFORM id
            FROM memberships
            WHERE user_id = '${MEMBER_ID}'
              AND organization_id = OLD.id
            FOR UPDATE;
            PERFORM pg_advisory_xact_lock(${COORDINATION_LOCK});
          END IF;
          RETURN OLD;
        END;
        $function$
      `);
      await setup.$executeRawUnsafe(`
        CREATE TRIGGER pause_organization_delete_after_membership_lock
        BEFORE DELETE ON organizations
        FOR EACH ROW
        EXECUTE FUNCTION pause_organization_delete_after_membership_lock()
      `);

      const plaintext = `svt_${randomUUID().replaceAll('-', '')}`;
      const fixture = await setup.$transaction(async (tx) => {
        const owner = await tx.user.create({
          data: {
            id: 'lock-order-owner',
            email: 'lock-order-owner@example.test',
          },
        });
        const member = await tx.user.create({
          data: {
            id: MEMBER_ID,
            email: 'lock-order-member@example.test',
          },
        });
        const organization = await tx.organization.create({
          data: {
            id: 'lock-order-deleted-organization',
            name: 'Deleted organization',
            slug: 'lock-order-deleted-organization',
            creatorUserId: owner.id,
          },
        });
        const fallbackOrganization = await tx.organization.create({
          data: {
            id: 'lock-order-fallback-organization',
            name: 'Fallback organization',
            slug: 'lock-order-fallback-organization',
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
              userId: member.id,
              organizationId: organization.id,
              role: 'MEMBER',
            },
            {
              userId: owner.id,
              organizationId: fallbackOrganization.id,
              role: 'OWNER',
            },
          ],
        });
        const project = await tx.project.create({
          data: {
            id: 'lock-order-project',
            name: 'Deleted project',
            slug: 'deleted-project',
            organizationId: organization.id,
          },
        });
        const apiToken = await tx.apiToken.create({
          data: {
            id: 'lock-order-api-token',
            name: 'Deletion race token',
            prefix: plaintext.slice(0, 8),
            tokenHash: hashToken(plaintext),
            scopes: ['checks:read', 'checks:write'],
            userId: member.id,
            projectId: project.id,
            projectNameSnapshot: project.name,
            organizationNameSnapshot: organization.name,
          },
        });
        return { apiToken, organization, owner, plaintext };
      });

      blockerRun = blocker.$transaction(
        async (tx) => {
          await tx.$queryRaw`
            SELECT CAST(
              pg_advisory_xact_lock(${COORDINATION_LOCK})
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
        fixture.owner.id,
        fixture.organization.id,
      );
      void deleteRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, 'token-lock-deletion'),
        'membership-delete trigger pause',
      );

      authenticateRun = apiTokenStrategy(authentication).validate(
        bearer(fixture.plaintext),
      );
      void authenticateRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, 'token-lock-authentication'),
        'authentication lock contention',
      );

      releaseBlocker.resolve();
      const [deleted, authenticated, blockerFinished] = await bounded(
        Promise.allSettled([deleteRun, authenticateRun, blockerRun]),
        'authentication/deletion race',
      );

      expect(blockerFinished).toEqual({
        status: 'fulfilled',
        value: undefined,
      });
      expect(deleted).toEqual({ status: 'fulfilled', value: true });
      expect(authenticated.status).toBe('rejected');
      if (authenticated.status === 'rejected') {
        expect(authenticated.reason).toBeInstanceOf(UnauthorizedException);
        expect((authenticated.reason as Error).message).toBe(
          'Credential project no longer exists',
        );
      }
      expect(
        await setup.organization.findUnique({
          where: { id: fixture.organization.id },
        }),
      ).toBeNull();
      expect(
        await setup.apiToken.findUniqueOrThrow({
          where: { id: fixture.apiToken.id },
          select: { projectId: true, lastUsedAt: true },
        }),
      ).toEqual({ projectId: null, lastUsedAt: null });
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled(
        [blockerRun, deleteRun, authenticateRun].filter(
          (operation) => operation !== undefined,
        ),
      );
      await Promise.allSettled(
        [setup, blocker, deletion, authentication, observer].map((prisma) =>
          prisma.$disconnect(),
        ),
      );
    }
  });
});
