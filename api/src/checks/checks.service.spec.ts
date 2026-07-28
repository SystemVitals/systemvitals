import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import {
  AccountEntitlementsService,
  type AccountEntitlements,
} from '../billing/account-entitlements.service';
import type { PrismaService } from '../prisma/prisma.service';
import { ChecksService } from './checks.service';

const account: AccountEntitlements = {
  plan: 'SOLO',
  limits: { maxChecks: 2, minIntervalSeconds: 60 },
  checkCount: 1,
  organizationCount: 2,
};

const destinationAccount: AccountEntitlements = {
  plan: 'FLEET',
  limits: { maxChecks: 100, minIntervalSeconds: 60 },
  checkCount: 5,
  organizationCount: 3,
};

const sourceProject = {
  id: 'project-source',
  organizationId: 'org-source',
  organization: { creatorUserId: 'creator-source' },
};

const destinationProject = {
  id: 'project-destination',
  organizationId: 'org-destination',
  organization: { creatorUserId: 'creator-destination' },
};

const movingCheck = {
  id: 'check-1',
  name: 'Nightly backup',
  slug: 'nightly-backup',
  type: 'HEARTBEAT',
  status: 'PAUSED',
  projectId: sourceProject.id,
  pingSlug: 'stable-ping',
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
  project: sourceProject,
};

function harness(member = true) {
  const order: string[] = [];
  const tx = {
    project: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push('project');
        return {
          id: 'project-a',
          organizationId: 'org-a',
          organization: { creatorUserId: 'creator' },
        };
      }),
    },
    membership: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push('member');
        return member ? { id: 'membership' } : null;
      }),
    },
    $queryRaw: jest.fn().mockImplementation(() => {
      order.push('rowLock');
      return [];
    }),
    check: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: object }) => {
        order.push('create');
        return { id: 'check', ...data };
      }),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const entitlements = {
    lockUsers: jest.fn().mockImplementation(() => order.push('lock')),
    forUser: jest.fn().mockImplementation(() => {
      order.push('count');
      return account;
    }),
    assertInterval: jest.fn(),
    assertCanAddCheck: jest.fn(),
  };
  return {
    order,
    tx,
    prisma,
    entitlements,
    service: new ChecksService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    ),
  };
}

type ProjectBoundUpdate = (
  userId: string,
  checkId: string,
  expectedProjectId: string,
  input: { intervalSeconds?: number; name?: string },
) => Promise<unknown>;

type ProjectBoundMutation = (
  userId: string,
  checkId: string,
  expectedProjectId: string,
) => Promise<unknown>;

function updateWithProjectBinding(
  service: ChecksService,
  userId: string,
  checkId: string,
  expectedProjectId: string,
  input: { intervalSeconds?: number; name?: string },
) {
  return (service.update as unknown as ProjectBoundUpdate).call(
    service,
    userId,
    checkId,
    expectedProjectId,
    input,
  );
}

function mutationWithProjectBinding(
  service: ChecksService,
  mutation: 'pause' | 'resume' | 'delete',
  userId: string,
  checkId: string,
  expectedProjectId: string,
) {
  return (service[mutation] as unknown as ProjectBoundMutation).call(
    service,
    userId,
    checkId,
    expectedProjectId,
  );
}

function staleMutationHarness() {
  const movedCheck = {
    ...movingCheck,
    projectId: destinationProject.id,
    project: destinationProject,
  };
  const check = {
    findUnique: jest
      .fn()
      .mockResolvedValueOnce(movingCheck)
      .mockResolvedValue(movedCheck),
    update: jest.fn().mockResolvedValue(movedCheck),
    delete: jest.fn().mockResolvedValue(movedCheck),
  };
  const membership = {
    findUnique: jest.fn().mockResolvedValue({ id: 'destination-membership' }),
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    check,
    membership,
    project: {
      findUnique: jest.fn().mockResolvedValue(sourceProject),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
    check,
    membership,
  };
  const entitlements = {
    lockUsers: jest.fn(),
    forUser: jest.fn(),
    assertInterval: jest.fn(),
    assertCanAddCheck: jest.fn(),
  };
  return {
    tx,
    prisma,
    service: new ChecksService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    ),
  };
}

function creatorStableMutationHarness() {
  const order: string[] = [];
  const check = {
    findUnique: jest.fn().mockImplementation(() => {
      order.push(
        check.findUnique.mock.calls.length === 1
          ? 'check:initial'
          : 'check:fresh',
      );
      return movingCheck;
    }),
    update: jest.fn().mockImplementation(() => {
      order.push('mutation');
      return movingCheck;
    }),
    delete: jest.fn().mockImplementation(() => {
      order.push('mutation');
      return movingCheck;
    }),
  };
  const tx = {
    check,
    project: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push('project:stable');
        return sourceProject;
      }),
    },
    membership: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push('membership');
        return { id: 'source-membership' };
      }),
    },
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const query = strings.join(' ');
      order.push(
        query.includes('FROM checks') ? 'lock:check' : 'lock:membership',
      );
      return [];
    }),
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const entitlements = {
    lockUsers: jest.fn().mockImplementation(() => {
      order.push('lock:creator');
    }),
    forUser: jest.fn(),
    assertInterval: jest.fn(),
    assertCanAddCheck: jest.fn(),
  };
  return {
    order,
    tx,
    prisma,
    entitlements,
    service: new ChecksService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    ),
  };
}

function moveHarness() {
  const order: string[] = [];
  const roles: Record<string, string | null> = {
    [sourceProject.organizationId]: 'OWNER',
    [destinationProject.organizationId]: 'OWNER',
  };
  const projects: Record<
    string,
    {
      id: string;
      organizationId: string;
      organization: { creatorUserId: string };
    }
  > = {
    [sourceProject.id]: sourceProject,
    [destinationProject.id]: destinationProject,
    'project-same-org': {
      id: 'project-same-org',
      organizationId: sourceProject.organizationId,
      organization: { creatorUserId: 'creator-source' },
    },
  };
  let currentCheck = { ...movingCheck };

  const tx = {
    project: {
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: { where: { id: string } }) => {
          order.push(`project:${where.id}`);
          return projects[where.id] ?? null;
        }),
    },
    membership: {
      findUnique: jest.fn().mockImplementation(
        ({
          where,
        }: {
          where: {
            userId_organizationId: {
              userId: string;
              organizationId: string;
            };
          };
        }) => {
          const organizationId = where.userId_organizationId.organizationId;
          order.push(`membership:${organizationId}`);
          const role = roles[organizationId];
          return role === null || role === undefined ? null : { role };
        },
      ),
    },
    $queryRaw: jest
      .fn()
      .mockImplementation(
        (strings: TemplateStringsArray, ...values: string[]) => {
          const query = strings.join(' ');
          if (query.includes('FROM checks')) {
            order.push('lock:check');
          } else if (query.includes('FROM memberships')) {
            order.push(`lock:membership:${values[1]}`);
          } else if (query.includes('pg_advisory_xact_lock')) {
            order.push('lock:project-coordination');
          } else if (query.includes('FROM status_pages')) {
            order.push('lock:status-pages');
          }
          return [];
        },
      ),
    check: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockImplementation(() => {
        order.push('check:findUnique');
        return currentCheck;
      }),
      findFirst: jest.fn().mockImplementation(() => {
        order.push('check:collision');
        return null;
      }),
      update: jest
        .fn()
        .mockImplementation(
          ({
            data,
          }: {
            where: { id: string };
            data: { projectId: string };
          }) => {
            order.push('check:update');
            currentCheck = {
              ...currentCheck,
              ...data,
              project: projects[data.projectId],
            };
            return currentCheck;
          },
        ),
    },
    statusPage: {
      findMany: jest.fn().mockImplementation(() => {
        order.push('statusPage:findMany');
        return [
          { id: 'page-1', checkIds: ['check-1', 'check-2'] },
          { id: 'page-2', checkIds: ['check-1'] },
        ];
      }),
      update: jest
        .fn()
        .mockImplementation(
          ({ where, data }: { where: { id: string }; data: object }) => {
            order.push(`statusPage:update:${where.id}`);
            return { id: where.id, ...data };
          },
        ),
    },
  };
  const prisma = {
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const entitlements = {
    lockUsers: jest.fn().mockImplementation(() => {
      order.push('lock:creators');
    }),
    forUser: jest.fn().mockImplementation(() => {
      order.push('entitlements:destination');
      return destinationAccount;
    }),
    assertInterval: jest.fn(),
    assertCanAddCheck: jest.fn().mockImplementation(() => {
      order.push('entitlements:assertCanAddCheck');
    }),
  };

  return {
    order,
    roles,
    projects,
    tx,
    prisma,
    entitlements,
    service: new ChecksService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    ),
  };
}

function readHarness() {
  const checks = [
    {
      id: 'check-1',
      name: 'API',
      slug: 'api',
      projectId: 'project-a',
    },
    {
      id: 'check-2',
      name: 'Worker',
      slug: 'worker',
      projectId: 'project-a',
    },
  ];
  const project = { id: 'project-a', organizationId: 'org-a' };
  const activeChannels = [
    { id: 'channel-1' },
    { id: 'channel-2' },
    { id: 'channel-3' },
  ];
  const exclusions = [
    { checkId: 'check-1', channelId: 'channel-2' },
    { checkId: 'check-2', channelId: 'channel-1' },
    { checkId: 'check-2', channelId: 'channel-3' },
  ];
  const prisma = {
    project: {
      findUnique: jest.fn().mockResolvedValue(project),
    },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ id: 'membership-1' }),
    },
    check: {
      findMany: jest.fn().mockResolvedValue(checks),
      findUnique: jest.fn().mockResolvedValue({ ...checks[0], project }),
      findFirst: jest.fn().mockResolvedValue(checks[0]),
    },
    notificationChannel: {
      findMany: jest.fn().mockResolvedValue(activeChannels),
    },
    checkChannelExclusion: {
      findMany: jest.fn().mockResolvedValue(exclusions),
    },
  };
  const entitlements = {
    lockUsers: jest.fn(),
    forUser: jest.fn(),
    assertInterval: jest.fn(),
    assertCanAddCheck: jest.fn(),
  };

  return {
    checks,
    project,
    activeChannels,
    exclusions,
    prisma,
    service: new ChecksService(
      prisma as unknown as PrismaService,
      entitlements as unknown as AccountEntitlementsService,
    ),
  };
}

describe('ChecksService effective notification channels', () => {
  it('returns only enabled same-project channels without matching exclusions', async () => {
    const h = readHarness();
    h.prisma.notificationChannel.findMany.mockResolvedValue([
      { id: 'channel-1' },
      { id: 'channel-3' },
    ]);

    await expect(
      h.service.effectiveNotificationChannelIds('check-1', h.project.id),
    ).resolves.toEqual(['channel-1', 'channel-3']);

    expect(h.prisma.notificationChannel.findMany).toHaveBeenCalledWith({
      where: {
        projectId: h.project.id,
        enabled: true,
        checkExclusions: { none: { checkId: 'check-1' } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  });

  it('returns an empty list when every enabled channel is excluded', async () => {
    const h = readHarness();
    h.prisma.notificationChannel.findMany.mockResolvedValue([]);

    await expect(
      h.service.effectiveNotificationChannelIds('check-1', h.project.id),
    ).resolves.toEqual([]);
  });

  it('ignores disabled and pending-verification channels', async () => {
    const h = readHarness();
    h.prisma.notificationChannel.findMany.mockResolvedValue([
      { id: 'verified-enabled' },
    ]);

    await expect(
      h.service.effectiveNotificationChannelIds('check-1', h.project.id),
    ).resolves.toEqual(['verified-enabled']);

    expect(h.prisma.notificationChannel.findMany).toHaveBeenCalledWith({
      where: {
        projectId: h.project.id,
        enabled: true,
        checkExclusions: { none: { checkId: 'check-1' } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
  });

  it('uses the provided transaction client', async () => {
    const h = readHarness();
    const tx = {
      notificationChannel: {
        findMany: jest.fn().mockResolvedValue([{ id: 'transaction-channel' }]),
      },
    };

    await expect(
      h.service.effectiveNotificationChannelIds(
        'check-1',
        h.project.id,
        tx as unknown as Prisma.TransactionClient,
      ),
    ).resolves.toEqual(['transaction-channel']);

    expect(tx.notificationChannel.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.notificationChannel.findMany).not.toHaveBeenCalled();
  });

  it('loads active project channels and exclusions once for the entire list', async () => {
    const h = readHarness();

    await expect(h.service.list('member', h.project.id)).resolves.toEqual([
      {
        ...h.checks[0],
        notificationChannelIds: ['channel-1', 'channel-3'],
      },
      {
        ...h.checks[1],
        notificationChannelIds: ['channel-2'],
      },
    ]);

    expect(h.prisma.notificationChannel.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.notificationChannel.findMany).toHaveBeenCalledWith({
      where: { projectId: h.project.id, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    expect(h.prisma.checkChannelExclusion.findMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.checkChannelExclusion.findMany).toHaveBeenCalledWith({
      where: { checkId: { in: ['check-1', 'check-2'] } },
      select: { checkId: true, channelId: true },
    });
  });

  it('attaches effective channel IDs to single-check reads', async () => {
    const h = readHarness();
    h.prisma.notificationChannel.findMany.mockResolvedValue([
      { id: 'channel-1' },
      { id: 'channel-3' },
    ]);

    await expect(h.service.findOne('member', 'check-1')).resolves.toEqual({
      ...h.checks[0],
      project: h.project,
      notificationChannelIds: ['channel-1', 'channel-3'],
    });
    await expect(
      h.service.findBySlug('member', 'org', 'project', 'api'),
    ).resolves.toEqual({
      ...h.checks[0],
      notificationChannelIds: ['channel-1', 'channel-3'],
    });
  });
});

describe('ChecksService shared account quota', () => {
  it.each([
    [
      'heartbeat',
      60,
      (service: ChecksService) =>
        service.create('member', 'project-a', 'Heartbeat', 10, 60),
    ],
    [
      'cron',
      300,
      (service: ChecksService) =>
        service.create(
          'member',
          'project-a',
          'Cron',
          10,
          undefined,
          '*/5 * * * *',
          'UTC',
        ),
    ],
    [
      'HTTP',
      60,
      (service: ChecksService) =>
        service.createActiveCheck(
          'member',
          'project-a',
          'HTTP',
          'HTTP',
          'https://example.com',
          60,
          5000,
        ),
    ],
    [
      'TCP',
      60,
      (service: ChecksService) =>
        service.createActiveCheck(
          'member',
          'project-a',
          'TCP',
          'TCP',
          'example.com:443',
          60,
          5000,
        ),
    ],
  ])(
    'routes %s creation through the same transaction boundary',
    async (_, requestedInterval, run) => {
      const h = harness();

      await run(h.service);

      expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(h.entitlements.lockUsers).toHaveBeenCalledWith(h.tx, ['creator']);
      expect(h.entitlements.forUser).toHaveBeenCalledWith(h.tx, 'creator');
      expect(h.entitlements.assertInterval).toHaveBeenCalledWith(
        account,
        requestedInterval,
      );
      expect(h.entitlements.assertCanAddCheck).toHaveBeenCalledWith(account);
      expect(h.tx.check.create).toHaveBeenCalledTimes(1);
      expect(h.order).toEqual([
        'project',
        'lock',
        'project',
        'rowLock',
        'member',
        'count',
        'create',
      ]);
    },
  );

  it('locks and authorizes membership after stabilizing the creator', async () => {
    const h = harness(false);

    await expect(
      h.service.create('outsider', 'project-a', 'Heartbeat', 10, 60),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.entitlements.lockUsers).toHaveBeenCalledWith(h.tx, ['creator']);
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.check.create).not.toHaveBeenCalled();
  });

  it('retries the whole creation transaction when creatorship changes', async () => {
    const h = harness();
    h.tx.project.findUnique
      .mockResolvedValueOnce({
        id: 'project-a',
        organizationId: 'org-a',
        organization: { creatorUserId: 'old-creator' },
      })
      .mockResolvedValueOnce({
        id: 'project-a',
        organizationId: 'org-a',
        organization: { creatorUserId: 'new-creator' },
      })
      .mockResolvedValue({
        id: 'project-a',
        organizationId: 'org-a',
        organization: { creatorUserId: 'new-creator' },
      });

    await h.service.create('member', 'project-a', 'Heartbeat', 10, 60);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(1, h.tx, [
      'old-creator',
    ]);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(2, h.tx, [
      'new-creator',
    ]);
    expect(h.entitlements.forUser).toHaveBeenCalledTimes(1);
    expect(h.entitlements.forUser).toHaveBeenCalledWith(h.tx, 'new-creator');
    expect(h.tx.check.create).toHaveBeenCalledTimes(1);
  });

  it('validates a shortened edit against the creator account without adding a check', async () => {
    const h = harness();
    Object.assign(h.tx.check, {
      findUnique: jest.fn().mockResolvedValue({
        id: 'check',
        name: 'Check',
        slug: 'check',
        type: 'HTTP',
        projectId: 'project-a',
        project: {
          organizationId: 'org-a',
          organization: { creatorUserId: 'creator' },
        },
        target: 'https://example.com',
        intervalSeconds: 300,
        timeoutMs: 5000,
        method: 'GET',
        expectedStatus: 200,
        periodSeconds: null,
        schedule: null,
        tz: null,
        pingSlug: null,
      }),
      update: jest.fn().mockResolvedValue({ id: 'check' }),
    });

    await updateWithProjectBinding(h.service, 'member', 'check', 'project-a', {
      intervalSeconds: 60,
    });

    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(h.entitlements.forUser).toHaveBeenCalledWith(h.tx, 'creator');
    expect(h.entitlements.assertInterval).toHaveBeenCalledWith(account, 60);
    expect(h.entitlements.assertCanAddCheck).not.toHaveBeenCalled();
  });

  it('rejects an update when the locked check moved after project authorization', async () => {
    const h = harness();
    const sourceCheck = {
      id: 'check',
      name: 'Check',
      slug: 'check',
      type: 'HTTP',
      projectId: 'project-a',
      project: {
        organizationId: 'org-a',
        organization: { creatorUserId: 'creator' },
      },
      target: 'https://example.com',
      intervalSeconds: 300,
      timeoutMs: 5000,
      method: 'GET',
      expectedStatus: 200,
      periodSeconds: null,
      schedule: null,
      tz: null,
      pingSlug: null,
    };
    const movedCheck = {
      ...sourceCheck,
      projectId: 'project-b',
      project: {
        organizationId: 'org-b',
        organization: { creatorUserId: 'creator' },
      },
    };
    Object.assign(h.tx.check, {
      findUnique: jest
        .fn()
        .mockResolvedValueOnce(sourceCheck)
        .mockResolvedValueOnce(movedCheck),
      update: jest.fn().mockResolvedValue(movedCheck),
    });

    await expect(
      updateWithProjectBinding(h.service, 'member', 'check', 'project-a', {
        name: 'Stale rename',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.tx.check.update).not.toHaveBeenCalled();
  });
});

describe('ChecksService project-bound status/delete mutations', () => {
  it('rejects an intermediate initial project before taking its creator lock', async () => {
    const h = creatorStableMutationHarness();
    const intermediateCheck = {
      ...movingCheck,
      projectId: destinationProject.id,
      project: destinationProject,
    };
    h.tx.check.findUnique.mockResolvedValue(intermediateCheck);
    h.tx.project.findUnique.mockResolvedValue(destinationProject);

    await expect(
      mutationWithProjectBinding(
        h.service,
        'pause',
        'owner',
        movingCheck.id,
        sourceProject.id,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.entitlements.lockUsers).not.toHaveBeenCalled();
    expect(h.tx.$queryRaw).not.toHaveBeenCalled();
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it.each(['pause', 'resume', 'delete'] as const)(
    'orders %s locks as creator, check, then membership',
    async (mutation) => {
      const h = creatorStableMutationHarness();

      await mutationWithProjectBinding(
        h.service,
        mutation,
        'owner',
        movingCheck.id,
        sourceProject.id,
      );

      expect(h.entitlements.lockUsers).toHaveBeenCalledWith(h.tx, [
        'creator-source',
      ]);
      expect(h.order).toEqual([
        'check:initial',
        'lock:creator',
        'project:stable',
        'lock:check',
        'check:fresh',
        'lock:membership',
        'membership',
        'mutation',
      ]);
    },
  );

  it('retries pause from the initial read when the creator changes', async () => {
    const h = creatorStableMutationHarness();
    const oldCreatorCheck = {
      ...movingCheck,
      project: {
        ...sourceProject,
        organization: { creatorUserId: 'creator-old' },
      },
    };
    h.tx.check.findUnique
      .mockResolvedValueOnce(oldCreatorCheck)
      .mockResolvedValueOnce(movingCheck)
      .mockResolvedValueOnce(movingCheck);

    await mutationWithProjectBinding(
      h.service,
      'pause',
      'owner',
      movingCheck.id,
      sourceProject.id,
    );

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(1, h.tx, [
      'creator-old',
    ]);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(2, h.tx, [
      'creator-source',
    ]);
    expect(h.tx.check.update).toHaveBeenCalledTimes(1);
  });

  it.each(['pause', 'resume', 'delete'] as const)(
    'rejects %s when the locked check no longer belongs to the authorized project',
    async (mutation) => {
      const h = staleMutationHarness();

      await expect(
        mutationWithProjectBinding(
          h.service,
          mutation,
          'owner',
          movingCheck.id,
          sourceProject.id,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(h.tx.check.update).not.toHaveBeenCalled();
      expect(h.tx.check.delete).not.toHaveBeenCalled();
    },
  );
});

describe('ChecksService move', () => {
  it('moves a check in one creator-stable transaction', async () => {
    const h = moveHarness();

    const result = await h.service.move(
      'acting-owner',
      movingCheck.id,
      destinationProject.id,
    );

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.entitlements.lockUsers).toHaveBeenCalledWith(h.tx, [
      'creator-source',
      'creator-destination',
    ]);
    expect(h.entitlements.forUser).toHaveBeenCalledWith(
      h.tx,
      'creator-destination',
    );
    expect(h.entitlements.assertCanAddCheck).toHaveBeenCalledWith(
      destinationAccount,
    );
    expect(h.tx.check.update).toHaveBeenCalledWith({
      where: { id: movingCheck.id },
      data: { projectId: destinationProject.id },
    });
    expect(result).toEqual(
      expect.objectContaining({
        id: movingCheck.id,
        projectId: destinationProject.id,
      }),
    );
  });

  it('removes only the moving check from source status pages', async () => {
    const h = moveHarness();

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);

    expect(h.tx.statusPage.findMany).toHaveBeenCalledWith({
      where: {
        projectId: sourceProject.id,
        checkIds: { has: movingCheck.id },
      },
      select: { id: true, checkIds: true },
    });
    expect(h.tx.statusPage.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'page-1' },
      data: { checkIds: ['check-2'] },
    });
    expect(h.tx.statusPage.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'page-2' },
      data: { checkIds: [] },
    });
  });

  it('preserves ping identity, paused status, and below-floor cadence', async () => {
    const h = moveHarness();

    const result = await h.service.move(
      'acting-owner',
      movingCheck.id,
      destinationProject.id,
    );

    expect(result).toEqual(
      expect.objectContaining({
        pingSlug: 'stable-ping',
        status: 'PAUSED',
        periodSeconds: 30,
      }),
    );
    expect(h.tx.check.update).toHaveBeenCalledWith({
      where: { id: movingCheck.id },
      data: { projectId: destinationProject.id },
    });
    expect(h.entitlements.assertInterval).not.toHaveBeenCalled();
  });

  it.each([
    ['ADMIN', 'OWNER', 'source'],
    ['MEMBER', 'OWNER', 'source'],
    ['OWNER', 'ADMIN', 'destination'],
    ['OWNER', 'MEMBER', 'destination'],
  ])(
    'rejects %s/%s roles when the acting user is not OWNER in the %s organization',
    async (sourceRole, destinationRole) => {
      const h = moveHarness();
      h.roles[sourceProject.organizationId] = sourceRole;
      h.roles[destinationProject.organizationId] = destinationRole;

      await expect(
        h.service.move('acting-owner', movingCheck.id, destinationProject.id),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(h.tx.statusPage.update).not.toHaveBeenCalled();
      expect(h.tx.check.update).not.toHaveBeenCalled();
    },
  );

  it('locks and reads each OWNER membership inside the transaction', async () => {
    const h = moveHarness();

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);

    expect(h.tx.membership.findUnique).toHaveBeenNthCalledWith(1, {
      where: {
        userId_organizationId: {
          userId: 'acting-owner',
          organizationId: sourceProject.organizationId,
        },
      },
      select: { role: true },
    });
    expect(h.tx.membership.findUnique).toHaveBeenNthCalledWith(2, {
      where: {
        userId_organizationId: {
          userId: 'acting-owner',
          organizationId: destinationProject.organizationId,
        },
      },
      select: { role: true },
    });
  });

  it('rejects a move to the current project without side effects', async () => {
    const h = moveHarness();

    await expect(
      h.service.move('acting-owner', movingCheck.id, sourceProject.id),
    ).rejects.toThrow('already in the destination project');

    expect(h.entitlements.lockUsers).not.toHaveBeenCalled();
    expect(h.tx.statusPage.update).not.toHaveBeenCalled();
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it('rejects a move to another project in the same organization', async () => {
    const h = moveHarness();

    await expect(
      h.service.move('acting-owner', movingCheck.id, 'project-same-org'),
    ).rejects.toThrow('another organization');

    expect(h.entitlements.lockUsers).not.toHaveBeenCalled();
    expect(h.tx.statusPage.update).not.toHaveBeenCalled();
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it('rejects a destination slug collision without side effects', async () => {
    const h = moveHarness();
    h.tx.check.findFirst.mockResolvedValue({ id: 'existing-check' });

    await expect(
      h.service.move('acting-owner', movingCheck.id, destinationProject.id),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.entitlements.forUser).not.toHaveBeenCalled();
    expect(h.tx.statusPage.update).not.toHaveBeenCalled();
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it('checks destination quota before any mutation and rolls back on rejection', async () => {
    const h = moveHarness();
    h.entitlements.assertCanAddCheck.mockImplementation(() => {
      h.order.push('entitlements:assertCanAddCheck');
      throw new ForbiddenException('Destination account is full');
    });

    await expect(
      h.service.move('acting-owner', movingCheck.id, destinationProject.id),
    ).rejects.toThrow('Destination account is full');

    expect(h.order).toContain('entitlements:assertCanAddCheck');
    expect(h.order).not.toContain('lock:status-pages');
    expect(h.tx.statusPage.update).not.toHaveBeenCalled();
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it('skips quota validation when both organizations share a creator', async () => {
    const h = moveHarness();
    h.projects[destinationProject.id] = {
      ...destinationProject,
      organization: { creatorUserId: 'creator-source' },
    };

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);

    expect(h.entitlements.lockUsers).toHaveBeenCalledWith(h.tx, [
      'creator-source',
      'creator-source',
    ]);
    expect(h.entitlements.forUser).not.toHaveBeenCalled();
    expect(h.entitlements.assertCanAddCheck).not.toHaveBeenCalled();
    expect(h.tx.check.update).toHaveBeenCalledTimes(1);
  });

  it('retries the whole transaction when the source creator changes', async () => {
    const h = moveHarness();
    const oldCheck = {
      ...movingCheck,
      project: {
        ...sourceProject,
        organization: { creatorUserId: 'creator-source-old' },
      },
    };
    const stableCheck = {
      ...movingCheck,
      project: {
        ...sourceProject,
        organization: { creatorUserId: 'creator-source-new' },
      },
    };
    h.tx.check.findUnique
      .mockResolvedValueOnce(oldCheck)
      .mockResolvedValueOnce(stableCheck)
      .mockResolvedValue(stableCheck);

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(1, h.tx, [
      'creator-source-old',
      'creator-destination',
    ]);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(2, h.tx, [
      'creator-source-new',
      'creator-destination',
    ]);
    expect(h.tx.check.update).toHaveBeenCalledTimes(1);
  });

  it('retries the whole transaction when the destination creator changes', async () => {
    const h = moveHarness();
    const oldDestination = {
      ...destinationProject,
      organization: { creatorUserId: 'creator-destination-old' },
    };
    const stableDestination = {
      ...destinationProject,
      organization: { creatorUserId: 'creator-destination-new' },
    };
    h.tx.project.findUnique
      .mockResolvedValueOnce(oldDestination)
      .mockResolvedValueOnce(stableDestination)
      .mockResolvedValue(stableDestination);

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(1, h.tx, [
      'creator-source',
      'creator-destination-old',
    ]);
    expect(h.entitlements.lockUsers).toHaveBeenNthCalledWith(2, h.tx, [
      'creator-source',
      'creator-destination-new',
    ]);
    expect(h.tx.check.update).toHaveBeenCalledTimes(1);
  });

  it('translates a concurrent destination slug P2002 into a conflict', async () => {
    const h = moveHarness();
    h.tx.check.update.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['project_id', 'slug'] },
      }),
    );

    await expect(
      h.service.move('acting-owner', movingCheck.id, destinationProject.id),
    ).rejects.toThrow(
      'A check with this slug already exists in the destination project',
    );
  });

  it('rejects a missing check before mutation', async () => {
    const h = moveHarness();
    h.tx.check.findUnique.mockResolvedValue(null);

    await expect(
      h.service.move('acting-owner', 'missing-check', destinationProject.id),
    ).rejects.toThrow('Check not found');
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it('rejects a missing destination before mutation', async () => {
    const h = moveHarness();
    h.tx.project.findUnique.mockResolvedValue(null);

    await expect(
      h.service.move('acting-owner', movingCheck.id, 'missing-project'),
    ).rejects.toThrow('Destination project not found');
    expect(h.tx.check.update).not.toHaveBeenCalled();
  });

  it('uses a stable lock-and-validation order before any writes', async () => {
    const h = moveHarness();

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);

    expect(h.order).toEqual([
      'check:findUnique',
      `project:${destinationProject.id}`,
      'lock:creators',
      'lock:check',
      'check:findUnique',
      `project:${destinationProject.id}`,
      `lock:membership:${sourceProject.organizationId}`,
      `membership:${sourceProject.organizationId}`,
      `lock:membership:${destinationProject.organizationId}`,
      `membership:${destinationProject.organizationId}`,
      'check:collision',
      'entitlements:destination',
      'entitlements:assertCanAddCheck',
      'lock:project-coordination',
      'lock:status-pages',
      'statusPage:findMany',
      'statusPage:update:page-1',
      'statusPage:update:page-2',
      'check:update',
    ]);
  });

  it('makes a repeated move fail safely without a second mutation', async () => {
    const h = moveHarness();

    await h.service.move('acting-owner', movingCheck.id, destinationProject.id);
    await expect(
      h.service.move('acting-owner', movingCheck.id, destinationProject.id),
    ).rejects.toThrow('already in the destination project');

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(h.tx.check.update).toHaveBeenCalledTimes(1);
    expect(h.tx.statusPage.update).toHaveBeenCalledTimes(2);
  });
});
