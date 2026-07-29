import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import type { CreateApiTokenInput } from './create-api-token.input';
import { TokensService } from './tokens.service';

const NOW = new Date('2026-07-29T12:00:00.000Z');

const project = {
  id: 'project-1',
  name: 'Default',
  organizationId: 'organization-1',
  organization: { name: 'Acme' },
};

function tokenRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'token-1',
    name: 'Agent',
    prefix: 'svt_1234',
    scopes: ['checks:read', 'checks:write'],
    projectId: project.id,
    projectNameSnapshot: project.name,
    organizationNameSnapshot: project.organization.name,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: NOW,
    project,
    ...overrides,
  };
}

function setup() {
  const resolveForUser = jest.fn().mockResolvedValue({
    organizationId: project.organizationId,
    projectId: project.id,
  });
  const projectFindFirst = jest.fn().mockResolvedValue(project);
  const tokenCreate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
    Promise.resolve(
      tokenRecord({
        name: data.name,
        scopes: data.scopes,
        projectId: data.projectId,
      }),
    ),
  );
  const tokenFindMany = jest.fn().mockResolvedValue([]);
  const prisma = {
    project: { findFirst: projectFindFirst },
    apiToken: { create: tokenCreate, findMany: tokenFindMany },
  } as unknown as PrismaService;
  const workspaces = {
    resolveForUser,
  } as unknown as WorkspacesService;
  const service = new TokensService(prisma, workspaces);

  return {
    service,
    resolveForUser,
    projectFindFirst,
    tokenCreate,
    tokenFindMany,
  };
}

function scopedInput(selector: {
  organizationId?: string;
  projectId?: string;
}): CreateApiTokenInput {
  return {
    name: 'Agent',
    capabilities: ['checks:write', 'checks:read'],
    ...selector,
  };
}

describe('TokensService', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves an organization workspace and stores its internal project ID', async () => {
    const { service, resolveForUser, tokenCreate } = setup();

    const result = await service.createScoped(
      'user-1',
      scopedInput({ organizationId: project.organizationId }),
    );

    expect(resolveForUser).toHaveBeenCalledWith('user-1', {
      organizationId: project.organizationId,
    });
    expect(tokenCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          projectId: project.id,
          projectNameSnapshot: project.name,
          organizationNameSnapshot: project.organization.name,
        }) as object,
      }),
    );
    expect(result).toMatchObject({
      organizationId: project.organizationId,
      projectId: project.id,
      organizationName: project.organization.name,
      projectName: project.name,
      scopes: ['checks:read', 'checks:write'],
    });
    expect(result.plaintext).toMatch(/^svt_[0-9a-f]{40}$/);
    expect(tokenCreate.mock.calls[0][0].data).not.toHaveProperty('plaintext');
  });

  it('continues accepting the deprecated project selector', async () => {
    const { service, resolveForUser } = setup();

    await expect(
      service.createScoped('user-1', scopedInput({ projectId: project.id })),
    ).resolves.toMatchObject({
      organizationId: project.organizationId,
      projectId: project.id,
    });
    expect(resolveForUser).toHaveBeenCalledWith('user-1', {
      projectId: project.id,
    });
  });

  it.each([
    ['both', { organizationId: 'organization-1', projectId: 'project-1' }],
    ['neither', {}],
  ])(
    'rejects %s workspace selectors before resolving them',
    async (_, input) => {
      const { service, resolveForUser, tokenCreate } = setup();

      await expect(
        service.createScoped('user-1', scopedInput(input)),
      ).rejects.toThrow(
        new BadRequestException(
          'Provide exactly one of organizationId or projectId',
        ),
      );
      expect(resolveForUser).not.toHaveBeenCalled();
      expect(tokenCreate).not.toHaveBeenCalled();
    },
  );

  it('derives organization identity for every listed live token in one query', async () => {
    const { service, tokenFindMany } = setup();
    tokenFindMany.mockResolvedValue([
      tokenRecord(),
      tokenRecord({
        id: 'token-2',
        projectId: 'project-2',
        project: {
          id: 'project-2',
          name: 'Default',
          organizationId: 'organization-2',
          organization: { name: 'Beta' },
        },
      }),
    ]);

    await expect(service.list('user-1')).resolves.toEqual([
      expect.objectContaining({
        id: 'token-1',
        organizationId: 'organization-1',
        organizationName: 'Acme',
      }),
      expect.objectContaining({
        id: 'token-2',
        organizationId: 'organization-2',
        organizationName: 'Beta',
      }),
    ]);
    expect(tokenFindMany).toHaveBeenCalledTimes(1);
  });

  it('keeps deleted-project snapshots readable without inventing an organization ID', async () => {
    const { service, tokenFindMany } = setup();
    tokenFindMany.mockResolvedValue([
      tokenRecord({
        projectId: null,
        project: null,
        projectNameSnapshot: 'Deleted project',
        organizationNameSnapshot: 'Deleted organization',
      }),
    ]);

    await expect(service.list('user-1')).resolves.toEqual([
      expect.objectContaining({
        organizationId: null,
        organizationName: 'Deleted organization',
        projectId: null,
        projectName: 'Deleted project',
      }),
    ]);
  });
});
