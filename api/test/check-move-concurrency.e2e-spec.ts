import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaClient } from '@systemvitals/database';
import { AccountEntitlementsService } from '../src/billing/account-entitlements.service';
import { ChecksService } from '../src/checks/checks.service';
import { buildApp } from '../src/main';
import { PrismaService } from '../src/prisma/prisma.service';
import { StatusPagesService } from '../src/status-pages/status-pages.service';
import { generateToken } from '../src/tokens/token.util';
import { cleanupTestUsers } from './cleanup-test-users';

const TIMEOUT_MS = 8_000;
const sourceUrl = process.env.DATABASE_URL ?? '';
if (!sourceUrl) throw new Error('DATABASE_URL is required');

jest.setTimeout(45_000);

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface GraphQlResponse {
  data?: Record<string, unknown>;
  errors?: Array<{ message: string }>;
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

function statusPagesService(prisma: PrismaClient): StatusPagesService {
  return new StatusPagesService(prisma as unknown as PrismaService);
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

async function holdStatusPageRow(
  prisma: PrismaClient,
  statusPageId: string,
  acquired: Deferred,
  release: Deferred,
): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`
        SELECT id FROM status_pages WHERE id = ${statusPageId} FOR UPDATE
      `;
      acquired.resolve();
      await release.promise;
    },
    { timeout: TIMEOUT_MS },
  );
}

describe('check move concurrency on the shared PostgreSQL database', () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const email = `move-race+${suffix}@example.test`;
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let appChecks: ChecksService;
  let ownerId: string;
  let sourceProjectId: string;
  let destinationProjectId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    appChecks = app.get(ChecksService);
    await cleanupTestUsers(prisma, email);

    const fixture = await prisma.$transaction(async (tx) => {
      const owner = await tx.user.create({ data: { email } });
      const sourceOrganization = await tx.organization.create({
        data: {
          name: `Move source ${suffix}`,
          slug: `move-source-${suffix}`,
          creatorUserId: owner.id,
        },
      });
      const destinationOrganization = await tx.organization.create({
        data: {
          name: `Move destination ${suffix}`,
          slug: `move-destination-${suffix}`,
          creatorUserId: owner.id,
        },
      });
      await tx.membership.createMany({
        data: [
          {
            userId: owner.id,
            organizationId: sourceOrganization.id,
            role: 'OWNER',
          },
          {
            userId: owner.id,
            organizationId: destinationOrganization.id,
            role: 'OWNER',
          },
        ],
      });
      const sourceProject = await tx.project.create({
        data: {
          name: 'Move source',
          slug: `source-${suffix}`,
          organizationId: sourceOrganization.id,
        },
      });
      const destinationProject = await tx.project.create({
        data: {
          name: 'Move destination',
          slug: `destination-${suffix}`,
          organizationId: destinationOrganization.id,
        },
      });
      return {
        owner,
        sourceOrganization,
        destinationOrganization,
        sourceProject,
        destinationProject,
      };
    });

    ownerId = fixture.owner.id;
    sourceProjectId = fixture.sourceProject.id;
    destinationProjectId = fixture.destinationProject.id;
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, email);
    } finally {
      await app.close();
    }
  });

  async function checkAndSourceToken(label: string) {
    const token = generateToken();
    return prisma.$transaction(async (tx) => {
      const check = await tx.check.create({
        data: {
          name: `Race ${label}`,
          slug: `race-${label}-${suffix}`,
          type: 'HEARTBEAT',
          status: 'NEW',
          projectId: sourceProjectId,
          pingSlug: randomUUID(),
          periodSeconds: 300,
          graceSeconds: 30,
        },
      });
      await tx.apiToken.create({
        data: {
          name: `Race ${label}`,
          prefix: token.prefix,
          tokenHash: token.hash,
          scopes: ['checks:write'],
          userId: ownerId,
          projectId: sourceProjectId,
          projectNameSnapshot: 'Move source',
          organizationNameSnapshot: `Move source ${suffix}`,
        },
      });
      return { check, plaintext: token.plaintext };
    });
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

  async function authorizeSourceThenMove(
    checkId: string,
    request: () => Promise<GraphQlResponse>,
  ): Promise<GraphQlResponse> {
    const authorized = deferred();
    const release = deferred();
    const original = appChecks.projectIdForCheck.bind(appChecks);
    const projectLookup = jest
      .spyOn(appChecks, 'projectIdForCheck')
      .mockImplementation(async (userId, requestedCheckId) => {
        const projectId = await original(userId, requestedCheckId);
        if (requestedCheckId === checkId) {
          authorized.resolve();
          await release.promise;
        }
        return projectId;
      });
    const requestRun = request();
    void requestRun.catch(() => undefined);

    try {
      await bounded(authorized.promise, 'source project authorization');
      await appChecks.move(ownerId, checkId, destinationProjectId);
      release.resolve();
      return await bounded(requestRun, 'project-bound mutation');
    } finally {
      release.resolve();
      projectLookup.mockRestore();
      await Promise.allSettled([requestRun]);
    }
  }

  it('rejects a source-scoped update authorized before the check moves', async () => {
    const fixture = await checkAndSourceToken('update');

    const response = await authorizeSourceThenMove(fixture.check.id, () =>
      gql(
        fixture.plaintext,
        `mutation($id: ID!, $input: UpdateCheckInput!) {
          updateCheck(id: $id, input: $input) { id name projectId }
        }`,
        { id: fixture.check.id, input: { name: 'Stale rename' } },
      ),
    );

    expect(response.errors?.[0]?.message).toMatch(/authorized project/i);
    expect(
      await prisma.check.findUniqueOrThrow({
        where: { id: fixture.check.id },
        select: { projectId: true, name: true },
      }),
    ).toEqual({
      projectId: destinationProjectId,
      name: fixture.check.name,
    });
  });

  it('rejects a source-scoped pause authorized before the check moves', async () => {
    const fixture = await checkAndSourceToken('pause');

    const response = await authorizeSourceThenMove(fixture.check.id, () =>
      gql(
        fixture.plaintext,
        `mutation($id: ID!) {
          pauseCheck(id: $id) { id status projectId }
        }`,
        { id: fixture.check.id },
      ),
    );

    expect(response.errors?.[0]?.message).toMatch(/authorized project/i);
    expect(
      await prisma.check.findUniqueOrThrow({
        where: { id: fixture.check.id },
        select: { projectId: true, status: true },
      }),
    ).toEqual({
      projectId: destinationProjectId,
      status: 'NEW',
    });
  });

  it('rejects a source-scoped delete authorized before the check moves', async () => {
    const fixture = await checkAndSourceToken('delete');

    const response = await authorizeSourceThenMove(fixture.check.id, () =>
      gql(fixture.plaintext, `mutation($id: ID!) { deleteCheck(id: $id) }`, {
        id: fixture.check.id,
      }),
    );

    expect(response.errors?.[0]?.message).toMatch(/authorized project/i);
    expect(
      await prisma.check.findUnique({
        where: { id: fixture.check.id },
        select: { projectId: true },
      }),
    ).toEqual({ projectId: destinationProjectId });
  });

  async function statusRaceFixture(label: string, checkIds: string[] = []) {
    const check = await prisma.check.create({
      data: {
        name: `Status race ${label}`,
        slug: `status-race-${label}-${suffix}`,
        type: 'HEARTBEAT',
        status: 'NEW',
        projectId: sourceProjectId,
        pingSlug: randomUUID(),
        periodSeconds: 300,
        graceSeconds: 30,
      },
    });
    const page = await prisma.statusPage.create({
      data: {
        projectId: sourceProjectId,
        slug: `status-race-page-${label}-${suffix}`,
        title: `Status race ${label}`,
        checkIds,
      },
    });
    return { check, page };
  }

  it('serializes status-page creation so it cannot insert a moved check reference', async () => {
    const fixture = await statusRaceFixture('create');
    const names = {
      blocker: `move-create-blocker-${suffix}`,
      move: `move-create-move-${suffix}`,
      status: `move-create-status-${suffix}`,
      observer: `move-create-observer-${suffix}`,
    };
    const blocker = client(names.blocker);
    const move = client(names.move);
    const status = client(names.status);
    const observer = client(names.observer);
    const blockerAcquired = deferred();
    const releaseBlocker = deferred();
    let blockerRun: Promise<void> | undefined;
    let moveRun: ReturnType<ChecksService['move']> | undefined;
    let statusRun: ReturnType<StatusPagesService['create']> | undefined;

    try {
      blockerRun = holdStatusPageRow(
        blocker,
        fixture.page.id,
        blockerAcquired,
        releaseBlocker,
      );
      void blockerRun.catch(() => undefined);
      await bounded(blockerAcquired.promise, 'status-page row blocker');

      moveRun = checksService(move).move(
        ownerId,
        fixture.check.id,
        destinationProjectId,
      );
      void moveRun.catch(() => undefined);
      await bounded(waitForLock(observer, names.move), 'move row contention');

      const createdSlug = `status-created-${suffix}`;
      statusRun = statusPagesService(status).create(
        ownerId,
        sourceProjectId,
        createdSlug,
        'Created during move',
        [fixture.check.id],
      );
      void statusRun.catch(() => undefined);
      const firstState = await bounded(
        Promise.race([
          statusRun.then(
            () => 'settled' as const,
            () => 'settled' as const,
          ),
          waitForLock(observer, names.status).then(() => 'blocked' as const),
        ]),
        'status-page create coordination',
      );
      expect(firstState).toBe('blocked');

      releaseBlocker.resolve();
      const [moveResult, statusResult] = await bounded(
        Promise.allSettled([moveRun, statusRun]),
        'move/status-page create race',
      );
      expect(moveResult.status).toBe('fulfilled');
      expect(statusResult.status).toBe('rejected');
      if (statusResult.status === 'rejected') {
        expect(statusResult.reason).toBeInstanceOf(BadRequestException);
      }
      expect(
        await prisma.statusPage.findUnique({ where: { slug: createdSlug } }),
      ).toBeNull();
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled(
        [blockerRun, moveRun, statusRun].filter(
          (operation) => operation !== undefined,
        ),
      );
      await Promise.allSettled(
        [blocker, move, status, observer].map((connection) =>
          connection.$disconnect(),
        ),
      );
    }
  });

  it('serializes status-page updates so stale validation cannot restore a moved check', async () => {
    const fixture = await statusRaceFixture('update');
    const names = {
      blocker: `move-update-blocker-${suffix}`,
      move: `move-update-move-${suffix}`,
      status: `move-update-status-${suffix}`,
      observer: `move-update-observer-${suffix}`,
    };
    const blocker = client(names.blocker);
    const move = client(names.move);
    const status = client(names.status);
    const observer = client(names.observer);
    const blockerAcquired = deferred();
    const releaseBlocker = deferred();
    let blockerRun: Promise<void> | undefined;
    let moveRun: ReturnType<ChecksService['move']> | undefined;
    let statusRun: ReturnType<StatusPagesService['update']> | undefined;

    try {
      blockerRun = holdStatusPageRow(
        blocker,
        fixture.page.id,
        blockerAcquired,
        releaseBlocker,
      );
      void blockerRun.catch(() => undefined);
      await bounded(blockerAcquired.promise, 'status-page row blocker');

      moveRun = checksService(move).move(
        ownerId,
        fixture.check.id,
        destinationProjectId,
      );
      void moveRun.catch(() => undefined);
      await bounded(waitForLock(observer, names.move), 'move row contention');

      statusRun = statusPagesService(status).update(ownerId, fixture.page.id, {
        checkIds: [fixture.check.id],
      });
      void statusRun.catch(() => undefined);
      await bounded(
        waitForLock(observer, names.status),
        'status-page update contention',
      );

      releaseBlocker.resolve();
      const [moveResult, statusResult] = await bounded(
        Promise.allSettled([moveRun, statusRun]),
        'move/status-page update race',
      );
      expect(moveResult.status).toBe('fulfilled');
      expect(statusResult.status).toBe('rejected');
      if (statusResult.status === 'rejected') {
        expect(statusResult.reason).toBeInstanceOf(BadRequestException);
      }
      expect(
        await prisma.statusPage.findUniqueOrThrow({
          where: { id: fixture.page.id },
          select: { checkIds: true },
        }),
      ).toEqual({ checkIds: [] });
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled(
        [blockerRun, moveRun, statusRun].filter(
          (operation) => operation !== undefined,
        ),
      );
      await Promise.allSettled(
        [blocker, move, status, observer].map((connection) =>
          connection.$disconnect(),
        ),
      );
    }
  });
});
