import {
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from './workspaces.service';

function harness() {
  const prisma = {
    organization: {
      findFirst: jest.fn(),
    },
    project: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  return {
    prisma,
    service: new WorkspacesService(prisma as unknown as PrismaService),
  };
}

describe('WorkspacesService.resolveForUser', () => {
  it('resolves an organization to its sole internal project with membership folded into the lookup', async () => {
    const { prisma, service } = harness();
    prisma.organization.findFirst.mockResolvedValue({
      id: 'org-1',
      projects: [{ id: 'project-1' }],
    });

    await expect(
      service.resolveForUser('user-1', { organizationId: 'org-1' }),
    ).resolves.toEqual({
      organizationId: 'org-1',
      projectId: 'project-1',
    });

    expect(prisma.organization.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'org-1',
        memberships: { some: { userId: 'user-1' } },
      },
      select: {
        id: true,
        projects: {
          select: { id: true },
          take: 2,
        },
      },
    });
  });

  it('resolves a legacy project with membership folded into the lookup', async () => {
    const { prisma, service } = harness();
    prisma.project.findFirst.mockResolvedValue({
      id: 'project-1',
      organizationId: 'org-1',
    });

    await expect(
      service.resolveForUser('user-1', { projectId: 'project-1' }),
    ).resolves.toEqual({
      organizationId: 'org-1',
      projectId: 'project-1',
    });

    expect(prisma.project.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'project-1',
        organization: { memberships: { some: { userId: 'user-1' } } },
      },
      select: { id: true, organizationId: true },
    });
  });

  it('rejects both identifiers before querying', async () => {
    const { prisma, service } = harness();

    await expect(
      service.resolveForUser('user-1', {
        organizationId: 'org-1',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('Provide exactly one of organizationId or projectId');

    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('rejects neither identifier before querying', async () => {
    const { prisma, service } = harness();

    await expect(service.resolveForUser('user-1', {})).rejects.toThrow(
      'Provide exactly one of organizationId or projectId',
    );

    expect(prisma.organization.findFirst).not.toHaveBeenCalled();
    expect(prisma.project.findFirst).not.toHaveBeenCalled();
  });

  it('does not disclose whether an inaccessible organization exists', async () => {
    const { prisma, service } = harness();
    prisma.organization.findFirst.mockResolvedValue(null);

    await expect(
      service.resolveForUser('user-1', { organizationId: 'org-private' }),
    ).rejects.toEqual(new ForbiddenException('Workspace not found'));
  });

  it('does not disclose whether an inaccessible legacy project exists', async () => {
    const { prisma, service } = harness();
    prisma.project.findFirst.mockResolvedValue(null);

    await expect(
      service.resolveForUser('user-1', { projectId: 'project-private' }),
    ).rejects.toEqual(new ForbiddenException('Workspace not found'));
  });

  it.each([
    ['zero', []],
    ['two', [{ id: 'project-1' }, { id: 'project-2' }]],
  ])(
    'rejects a visible organization with %s projects as inconsistent',
    async (_count, projects) => {
      const { prisma, service } = harness();
      prisma.organization.findFirst.mockResolvedValue({
        id: 'org-1',
        projects,
      });

      await expect(
        service.resolveForUser('user-1', { organizationId: 'org-1' }),
      ).rejects.toEqual(
        new InternalServerErrorException(
          'Organization workspace is inconsistent',
        ),
      );
    },
  );
});

describe('WorkspacesService.resolveOrganizationForProject', () => {
  it('resolves an internal project to its organization', async () => {
    const { prisma, service } = harness();
    prisma.project.findUnique.mockResolvedValue({
      organizationId: 'org-1',
    });

    await expect(
      service.resolveOrganizationForProject('project-1'),
    ).resolves.toBe('org-1');

    expect(prisma.project.findUnique).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      select: { organizationId: true },
    });
  });

  it('uses the same generic failure for an unknown internal project', async () => {
    const { prisma, service } = harness();
    prisma.project.findUnique.mockResolvedValue(null);

    await expect(
      service.resolveOrganizationForProject('missing-project'),
    ).rejects.toEqual(new ForbiddenException('Workspace not found'));
  });
});
