import type { PrismaService } from '../prisma/prisma.service';
import { StatusPagesService } from './status-pages.service';

const project = {
  id: 'project-source',
  organizationId: 'org-source',
};

const page = {
  id: 'page-1',
  projectId: project.id,
  project,
  slug: 'public',
  title: 'Public status',
  branding: null,
  checkIds: ['check-1'],
};

function database(order: string[], scope: 'root' | 'tx') {
  return {
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('pg_advisory_xact_lock')) {
        order.push(`${scope}:lock-project`);
      }
      return [];
    }),
    project: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push(`${scope}:project`);
        return project;
      }),
    },
    membership: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push(`${scope}:membership`);
        return { id: 'membership-1' };
      }),
    },
    check: {
      findMany: jest.fn().mockImplementation(() => {
        order.push(`${scope}:checks`);
        return [{ id: 'check-1' }];
      }),
    },
    statusPage: {
      findUnique: jest.fn().mockImplementation(() => {
        order.push(`${scope}:page`);
        return page;
      }),
      create: jest.fn().mockImplementation(() => {
        order.push(`${scope}:create`);
        return page;
      }),
      update: jest.fn().mockImplementation(() => {
        order.push(`${scope}:update`);
        return page;
      }),
    },
  };
}

function harness() {
  const order: string[] = [];
  const root = database(order, 'root');
  const tx = database(order, 'tx');
  const prisma = {
    ...root,
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };
  return {
    order,
    root,
    tx,
    prisma,
    service: new StatusPagesService(prisma as unknown as PrismaService),
  };
}

describe('StatusPagesService project coordination', () => {
  it('creates inside a transaction that locks the project before check validation', async () => {
    const h = harness();

    await h.service.create('owner', project.id, 'public', 'Public status', [
      'check-1',
    ]);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual([
      'tx:lock-project',
      'tx:project',
      'tx:membership',
      'tx:checks',
      'tx:create',
    ]);
    expect(h.root.statusPage.create).not.toHaveBeenCalled();
  });

  it('fresh-reads and updates a page under its project lock', async () => {
    const h = harness();

    await h.service.update('owner', page.id, { checkIds: ['check-1'] });

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual([
      'tx:page',
      'tx:lock-project',
      'tx:page',
      'tx:membership',
      'tx:checks',
      'tx:update',
    ]);
    expect(h.root.statusPage.update).not.toHaveBeenCalled();
  });
});
