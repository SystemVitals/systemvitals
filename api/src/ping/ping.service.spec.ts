import { NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { AlertQueueService } from '../queue/alert-queue.service';
import { PingService } from './ping.service';

const initialCheck = {
  id: 'check-1',
  pingSlug: 'heartbeat-slug',
  type: 'HEARTBEAT',
  status: 'DOWN',
  projectId: 'project-1',
};

function harness() {
  const order: string[] = [];
  const freshCheck = { ...initialCheck };
  const tx = {
    $queryRaw: jest.fn().mockImplementation(() => {
      order.push('lock:check');
      return [];
    }),
    check: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push('read:locked-check');
        return freshCheck;
      }),
      update: jest.fn().mockImplementation(({ data }: { data: object }) => {
        order.push('update:check');
        return { ...freshCheck, ...data };
      }),
    },
    checkEvent: {
      create: jest.fn().mockImplementation(({ data }: { data: object }) => {
        order.push('create:event');
        return { id: 'event-1', ...data };
      }),
    },
    notificationChannel: {
      findMany: jest.fn().mockImplementation(() => {
        order.push('read:snapshot');
        return [{ id: 'channel-early' }, { id: 'channel-late' }];
      }),
    },
  };
  const prisma = {
    check: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push('read:initial-check');
        return initialCheck;
      }),
    },
    $transaction: jest.fn(
      async (operation: (client: typeof tx) => Promise<unknown>) => {
        order.push('transaction:start');
        const result = await operation(tx);
        order.push('transaction:commit');
        return result;
      },
    ),
  };
  const alertQueue = {
    enqueue: jest.fn().mockImplementation(() => {
      order.push('enqueue');
      return Promise.resolve();
    }),
  };

  return {
    order,
    freshCheck,
    tx,
    prisma,
    alertQueue,
    service: new PingService(
      prisma as unknown as PrismaService,
      alertQueue as unknown as AlertQueueService,
    ),
  };
}

describe('PingService recordPing', () => {
  it('locks and re-reads before atomically recording a recovery snapshot', async () => {
    const h = harness();

    await expect(h.service.recordPing(initialCheck.pingSlug)).resolves.toEqual({
      recovered: true,
      checkId: initialCheck.id,
    });

    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [query, checkId] = h.tx.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      string,
    ];
    expect(query.join(' ')).toContain('SELECT id FROM checks');
    expect(query.join(' ')).toContain('FOR UPDATE');
    expect(checkId).toBe(initialCheck.id);
    expect(h.tx.check.findUnique).toHaveBeenCalledWith({
      where: { id: initialCheck.id },
    });
    expect(h.tx.notificationChannel.findMany).toHaveBeenCalledWith({
      where: {
        projectId: initialCheck.projectId,
        enabled: true,
        checkExclusions: { none: { checkId: initialCheck.id } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    });
    expect(h.alertQueue.enqueue).toHaveBeenCalledWith({
      checkId: initialCheck.id,
      kind: 'recovery',
      channelIds: ['channel-early', 'channel-late'],
    });
    expect(h.order).toEqual([
      'read:initial-check',
      'transaction:start',
      'lock:check',
      'read:locked-check',
      'create:event',
      'update:check',
      'read:snapshot',
      'transaction:commit',
      'enqueue',
    ]);
  });

  it('snapshots an explicitly all-off check as an empty recipient list', async () => {
    const h = harness();
    h.tx.notificationChannel.findMany.mockResolvedValue([]);

    await h.service.recordPing(initialCheck.pingSlug);

    expect(h.alertQueue.enqueue).toHaveBeenCalledWith({
      checkId: initialCheck.id,
      kind: 'recovery',
      channelIds: [],
    });
  });

  it('records a later UP ping without reading recipients or enqueueing recovery', async () => {
    const h = harness();
    h.tx.check.findUnique.mockResolvedValue({
      ...h.freshCheck,
      status: 'UP',
    });

    await expect(h.service.recordPing(initialCheck.pingSlug)).resolves.toEqual({
      recovered: false,
      checkId: initialCheck.id,
    });

    expect(h.tx.checkEvent.create).toHaveBeenCalledTimes(1);
    expect(h.tx.checkEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        checkId: initialCheck.id,
        status: 'UP',
        sourceIp: null,
      }) as object,
    });
    expect(h.tx.check.update).toHaveBeenCalledTimes(1);
    expect(h.tx.notificationChannel.findMany).not.toHaveBeenCalled();
    expect(h.alertQueue.enqueue).not.toHaveBeenCalled();
  });

  it('stores the heartbeat origin IP on the UP event', async () => {
    const h = harness();
    h.tx.check.findUnique.mockResolvedValue({
      ...h.freshCheck,
      status: 'UP',
    });

    await h.service.recordPing(initialCheck.pingSlug, '203.0.113.40');

    expect(h.tx.checkEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        checkId: initialCheck.id,
        status: 'UP',
        sourceIp: '203.0.113.40',
      }) as object,
    });
  });

  it.each([
    ['deleted', null],
    ['converted', { ...initialCheck, type: 'HTTP' }],
  ])(
    'returns generic NotFound when the check is %s after the initial lookup',
    async (_state, lockedCheck) => {
      const h = harness();
      h.tx.check.findUnique.mockResolvedValue(lockedCheck);

      await expect(h.service.recordPing(initialCheck.pingSlug)).rejects.toEqual(
        new NotFoundException('Check not found'),
      );

      expect(h.tx.checkEvent.create).not.toHaveBeenCalled();
      expect(h.tx.check.update).not.toHaveBeenCalled();
      expect(h.tx.notificationChannel.findMany).not.toHaveBeenCalled();
      expect(h.alertQueue.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['unknown', null],
    ['already converted', { ...initialCheck, type: 'TCP' }],
  ])(
    'preserves the slug-specific fast rejection for an %s check',
    async (_state, check) => {
      const h = harness();
      h.prisma.check.findUnique.mockResolvedValue(check);

      await expect(h.service.recordPing(initialCheck.pingSlug)).rejects.toEqual(
        new NotFoundException(
          `No check found for slug: ${initialCheck.pingSlug}`,
        ),
      );

      expect(h.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('does not wait for recovery enqueue completion', async () => {
    const h = harness();
    h.alertQueue.enqueue.mockReturnValue(new Promise<void>(() => undefined));

    await expect(h.service.recordPing(initialCheck.pingSlug)).resolves.toEqual({
      recovered: true,
      checkId: initialCheck.id,
    });
  });
});
