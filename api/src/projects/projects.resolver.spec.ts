import type { JwtUser } from '../auth/jwt.strategy';
import type { PrismaService } from '../prisma/prisma.service';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import { ProjectsResolver } from './projects.resolver';
import { ProjectsService } from './projects.service';

const user = { userId: 'user-1' } as JwtUser;

function harness() {
  const projectsService = {
    regenerateOrganizationPingKey: jest
      .fn()
      .mockResolvedValue({ id: 'project-1', organizationId: 'org-1' }),
    regeneratePingKey: jest
      .fn()
      .mockResolvedValue({ id: 'project-1', organizationId: 'org-1' }),
    listForUser: jest.fn().mockResolvedValue([]),
  };

  return {
    projectsService,
    resolver: new ProjectsResolver(
      projectsService as unknown as ProjectsService,
    ),
  };
}

describe('ProjectsResolver ping-key compatibility', () => {
  it('rotates the implicit project key by canonical organization ID', async () => {
    const { projectsService, resolver } = harness();

    await resolver.regenerateOrganizationPingKey(user, 'org-1');

    expect(projectsService.regenerateOrganizationPingKey).toHaveBeenCalledWith(
      'user-1',
      'org-1',
    );
  });

  it('retains legacy project-ID rotation for one release', async () => {
    const { projectsService, resolver } = harness();

    await resolver.regeneratePingKey(user, 'project-1');

    expect(projectsService.regeneratePingKey).toHaveBeenCalledWith(
      'user-1',
      'project-1',
    );
  });
});

describe('ProjectsService ping-key compatibility', () => {
  function serviceHarness() {
    let currentPingKey = 'old-key';
    const prisma = {
      project: {
        update: jest
          .fn()
          .mockImplementation(
            ({
              where,
              data,
            }: {
              where: { id: string };
              data: { pingKey: string };
            }) =>
              Promise.resolve({
                id: where.id,
                name: 'Default',
                slug: 'default',
                organizationId: 'org-1',
                pingKey: (currentPingKey = data.pingKey),
              }),
          ),
        findMany: jest.fn(),
      },
      organization: {
        findFirst: jest.fn().mockImplementation(() =>
          Promise.resolve({
            id: 'org-1',
            name: 'Acme',
            slug: 'acme',
            creatorUserId: 'creator-1',
            projects: [
              {
                id: 'project-1',
                name: 'Default',
                slug: 'default',
                organizationId: 'org-1',
                pingKey: currentPingKey,
              },
            ],
            memberships: [{ role: 'OWNER' }],
            creator: {
              email: 'creator@example.test',
              subscription: { plan: 'SIGNAL' },
            },
          }),
        ),
      },
    };
    const workspaces = {
      resolveForUser: jest.fn().mockResolvedValue({
        organizationId: 'org-1',
        projectId: 'project-1',
      }),
    };
    return {
      prisma,
      workspaces,
      service: new ProjectsService(
        prisma as unknown as PrismaService,
        workspaces as unknown as WorkspacesService,
      ),
    };
  }

  it('authorizes the legacy selector before using the shared rotation', async () => {
    const { prisma, service, workspaces } = serviceHarness();

    const project = await service.regeneratePingKey('user-1', 'project-1');

    expect(workspaces.resolveForUser).toHaveBeenCalledWith('user-1', {
      projectId: 'project-1',
    });
    expect(project.pingKey).toMatch(/^[0-9a-f]{40}$/);
    expect(prisma.project.update).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      data: { pingKey: project.pingKey },
    });
    expect(project.id).toBe('project-1');
  });

  it('authorizes the canonical selector and presents the rotated key on the organization', async () => {
    const { prisma, service, workspaces } = serviceHarness();

    const organization = await service.regenerateOrganizationPingKey(
      'user-1',
      'org-1',
    );

    expect(workspaces.resolveForUser).toHaveBeenCalledWith('user-1', {
      organizationId: 'org-1',
    });
    expect(prisma.project.update).toHaveBeenCalledTimes(1);
    expect(organization.pingKey).toMatch(/^[0-9a-f]{40}$/);
    expect(organization).toEqual({
      id: 'org-1',
      name: 'Acme',
      slug: 'acme',
      pingKey: organization.pingKey,
      role: 'OWNER',
      plan: 'SIGNAL',
      creatorUserId: 'creator-1',
      creatorLabel: 'creator@example.test',
      projects: [
        {
          id: 'project-1',
          name: 'Default',
          slug: 'default',
          organizationId: 'org-1',
          pingKey: organization.pingKey,
        },
      ],
    });
  });
});
