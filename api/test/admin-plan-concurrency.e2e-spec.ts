import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { PrismaClient } from '@systemvitals/database';
import { AdminService } from '../src/admin/admin.service';
import type { AuthService } from '../src/auth/auth.service';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { OrganizationsService } from '../src/organizations/organizations.service';
import type { PrismaService } from '../src/prisma/prisma.service';

const TIMEOUT_MS = 8_000;
const sourceUrl = process.env.DATABASE_URL;
if (!sourceUrl) throw new Error('DATABASE_URL is required');

const databaseDir = resolve(__dirname, '../../database');
const databaseName = `systemvitals_admin_plan_${randomUUID().replaceAll('-', '')}`;
if (!/^[a-z][a-z0-9_]+$/.test(databaseName)) {
  throw new Error(`Unsafe temporary database name: ${databaseName}`);
}
const quotedDatabaseName = `"${databaseName}"`;
const adminUrl = new URL(sourceUrl);
adminUrl.search = '';
const testUrl = new URL(sourceUrl);
testUrl.pathname = `/${databaseName}`;
testUrl.searchParams.set('schema', 'public');

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

class PausingEntitlements extends AccountEntitlementsService {
  constructor(
    prisma: PrismaService,
    private readonly locked: Deferred,
    private readonly release: Deferred,
  ) {
    super(prisma);
  }

  override async lockUsers(
    tx: Parameters<AccountEntitlementsService['lockUsers']>[0],
    userIds: string[],
  ): Promise<void> {
    await super.lockUsers(tx, userIds);
    this.locked.resolve();
    await this.release.promise;
  }
}

function adminService(
  prisma: PrismaClient,
  entitlements: AccountEntitlementsService,
): AdminService {
  return new AdminService(
    prisma as unknown as PrismaService,
    {} as AuthService,
    entitlements,
  );
}

function organizations(
  prisma: PrismaClient,
  entitlements: AccountEntitlementsService,
): OrganizationsService {
  return new OrganizationsService(
    prisma as unknown as PrismaService,
    entitlements,
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`${applicationName} did not contend on a row lock`);
}

async function createFixture(prisma: PrismaClient, suffix: string) {
  const actorId = `admin-${suffix}`;
  const userId = `account-${suffix}`;
  await prisma.user.createMany({
    data: [
      {
        id: actorId,
        email: `${actorId}@example.test`,
        passwordHash: 'not-used',
        isAdmin: true,
      },
      {
        id: userId,
        email: `${userId}@example.test`,
        passwordHash: 'not-used',
      },
    ],
  });
  await prisma.subscription.create({
    data: { userId, plan: 'SIGNAL', status: 'active' },
  });
  for (let index = 0; index < 10; index += 1) {
    const organizationId = `existing-${suffix}-${index}`;
    await prisma.organization.create({
      data: {
        id: organizationId,
        name: organizationId,
        slug: organizationId,
        creatorUserId: userId,
        memberships: {
          create: { userId, role: 'OWNER' },
        },
        projects: {
          create: { name: 'Default', slug: 'default' },
        },
      },
    });
  }
  return { actorId, userId };
}

describe('admin plan serialization (fresh PostgreSQL database)', () => {
  beforeAll(() => {
    try {
      sql(`CREATE DATABASE ${quotedDatabaseName}`);
      run('npx', ['prisma', 'migrate', 'deploy'], {
        DATABASE_URL: testUrl.toString(),
      });
    } catch (error) {
      sql(`DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`);
      throw error;
    }
  }, 30_000);

  afterAll(() => {
    sql(`DROP DATABASE IF EXISTS ${quotedDatabaseName} WITH (FORCE)`);
  });

  it('preserves creation-first overage after manual downgrade and blocks the next creation', async () => {
    const setup = client('admin-plan-creation-first-setup');
    const creationClient = client('admin-plan-creation-first-creation');
    const adminClient = client('admin-plan-creation-first-admin');
    const observer = client('admin-plan-creation-first-observer');
    const locked = deferred();
    const release = deferred();
    try {
      const { actorId, userId } = await createFixture(setup, 'creation-first');
      const creation = organizations(
        creationClient,
        new PausingEntitlements(
          creationClient as unknown as PrismaService,
          locked,
          release,
        ),
      ).create(userId, 'Allowed before downgrade');
      await bounded(locked.promise, 'creation account lock');
      const downgrade = adminService(
        adminClient,
        new AccountEntitlementsService(adminClient as unknown as PrismaService),
      ).setUserPlan(actorId, userId, 'SOLO', null, true);
      await waitForLock(observer, 'admin-plan-creation-first-admin');
      release.resolve();
      await bounded(
        Promise.all([creation, downgrade]),
        'creation-first serialization',
      );

      expect(
        await setup.organization.count({ where: { creatorUserId: userId } }),
      ).toBe(11);
      await expect(
        organizations(
          setup,
          new AccountEntitlementsService(setup as unknown as PrismaService),
        ).create(userId, 'Blocked after downgrade'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await setup.organization.count({ where: { creatorUserId: userId } }),
      ).toBe(11);
    } finally {
      release.resolve();
      await Promise.allSettled([
        setup.$disconnect(),
        creationClient.$disconnect(),
        adminClient.$disconnect(),
        observer.$disconnect(),
      ]);
    }
  });

  it('rejects creation when the manual downgrade obtains the account lock first', async () => {
    const setup = client('admin-plan-downgrade-first-setup');
    const creationClient = client('admin-plan-downgrade-first-creation');
    const adminClient = client('admin-plan-downgrade-first-admin');
    const observer = client('admin-plan-downgrade-first-observer');
    const locked = deferred();
    const release = deferred();
    try {
      const { actorId, userId } = await createFixture(setup, 'downgrade-first');
      const downgrade = adminService(
        adminClient,
        new PausingEntitlements(
          adminClient as unknown as PrismaService,
          locked,
          release,
        ),
      ).setUserPlan(actorId, userId, 'SOLO', null, true);
      await bounded(locked.promise, 'admin account lock');
      const creation = organizations(
        creationClient,
        new AccountEntitlementsService(
          creationClient as unknown as PrismaService,
        ),
      ).create(userId, 'Rejected after downgrade');
      await waitForLock(observer, 'admin-plan-downgrade-first-creation');
      release.resolve();

      await bounded(downgrade, 'manual downgrade');
      await expect(
        bounded(creation, 'post-downgrade creation'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        await setup.organization.count({ where: { creatorUserId: userId } }),
      ).toBe(10);
    } finally {
      release.resolve();
      await Promise.allSettled([
        setup.$disconnect(),
        creationClient.$disconnect(),
        adminClient.$disconnect(),
        observer.$disconnect(),
      ]);
    }
  });
});
