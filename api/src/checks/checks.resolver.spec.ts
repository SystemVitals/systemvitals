import type { ApiPrincipal } from '../tokens/api-principal';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import { ChecksResolver } from './checks.resolver';
import type { ChecksService } from './checks.service';

const principal: ApiPrincipal = {
  userId: 'owner',
  email: 'owner@example.test',
  authKind: 'api-token',
  apiToken: {
    id: 'token',
    projectId: 'project-source',
    capabilities: ['checks:read', 'checks:write'],
    legacyScopes: [],
  },
};

function harness() {
  const service = {
    list: jest.fn().mockResolvedValue([{ id: 'check-1' }]),
    create: jest.fn().mockResolvedValue({ id: 'check-1' }),
    createActiveCheck: jest.fn().mockResolvedValue({ id: 'check-1' }),
    findByOrganizationSlug: jest.fn().mockResolvedValue({
      id: 'check-1',
      projectId: 'project-source',
    }),
    findBySlug: jest.fn().mockResolvedValue({
      id: 'check-1',
      projectId: 'project-source',
    }),
    move: jest.fn().mockResolvedValue({
      id: 'check-1',
      projectId: 'project-destination',
    }),
    projectIdForCheck: jest.fn().mockResolvedValue('project-source'),
    effectiveNotificationChannelIds: jest
      .fn()
      .mockResolvedValue(['channel-fallback']),
    setCheckChannelEnabled: jest.fn().mockResolvedValue({ id: 'check-1' }),
    update: jest.fn().mockResolvedValue({ id: 'check-1' }),
    pause: jest.fn().mockResolvedValue({ id: 'check-1' }),
    resume: jest.fn().mockResolvedValue({ id: 'check-1' }),
    delete: jest.fn().mockResolvedValue(true),
  };
  const workspaces = {
    resolveForUser: jest.fn().mockImplementation(
      (
        _userId: string,
        selector: {
          organizationId?: string | null;
          projectId?: string | null;
        },
      ) => {
        const hasOrganizationId = selector.organizationId != null;
        const hasProjectId = selector.projectId != null;
        if (hasOrganizationId === hasProjectId) {
          throw new Error('Provide exactly one of organizationId or projectId');
        }
        if (
          selector.organizationId === 'org-destination' ||
          selector.projectId === 'project-destination'
        ) {
          return {
            organizationId: 'org-destination',
            projectId: 'project-destination',
          };
        }
        return {
          organizationId: 'org-source',
          projectId: 'project-source',
        };
      },
    ),
    resolveOrganizationForProject: jest.fn().mockResolvedValue('org-source'),
  };
  return {
    service,
    workspaces,
    resolver: new ChecksResolver(
      service as unknown as ChecksService,
      workspaces as unknown as WorkspacesService,
    ),
  };
}

const sessionPrincipal: ApiPrincipal = {
  userId: 'owner',
  email: 'owner@example.test',
  authKind: 'session',
};

describe('ChecksResolver workspace selectors', () => {
  it('resolves an organization before enforcing the project-bound list capability', async () => {
    const h = harness();

    await expect(h.resolver.checks(principal, 'org-source')).resolves.toEqual([
      { id: 'check-1', organizationId: 'org-source' },
    ]);

    expect(h.workspaces.resolveForUser).toHaveBeenCalledWith('owner', {
      organizationId: 'org-source',
      projectId: undefined,
    });
    expect(h.service.list).toHaveBeenCalledWith('owner', 'project-source');
    expect(
      h.workspaces.resolveForUser.mock.invocationCallOrder[0],
    ).toBeLessThan(h.service.list.mock.invocationCallOrder[0]);
  });

  it('keeps legacy project selectors working for check creation', async () => {
    const h = harness();

    await expect(
      h.resolver.createCheck(
        principal,
        undefined,
        'project-source',
        'Nightly',
        60,
        300,
      ),
    ).resolves.toEqual({
      id: 'check-1',
      organizationId: 'org-source',
    });

    expect(h.workspaces.resolveForUser).toHaveBeenCalledWith('owner', {
      organizationId: undefined,
      projectId: 'project-source',
    });
    expect(h.service.create).toHaveBeenCalledWith(
      'owner',
      'project-source',
      'Nightly',
      60,
      300,
      undefined,
      undefined,
    );
  });

  it('resolves an organization before enforcing the project-bound active-check capability', async () => {
    const h = harness();

    await expect(
      h.resolver.createActiveCheck(
        principal,
        'org-source',
        undefined,
        'Homepage',
        'HTTP',
        'https://example.test',
        60,
        5000,
      ),
    ).resolves.toEqual({
      id: 'check-1',
      organizationId: 'org-source',
    });

    expect(h.service.createActiveCheck).toHaveBeenCalledWith(
      'owner',
      'project-source',
      'Homepage',
      'HTTP',
      'https://example.test',
      60,
      5000,
      undefined,
      undefined,
    );
  });

  it.each([
    ['both', 'org-source', 'project-source'],
    ['neither', undefined, undefined],
  ])(
    'rejects %s list selectors with the stable XOR error',
    async (_label, organizationId, projectId) => {
      const h = harness();

      await expect(
        h.resolver.checks(principal, organizationId, projectId),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');

      expect(h.service.list).not.toHaveBeenCalled();
    },
  );

  it('resolves a canonical destination organization before moving', async () => {
    const h = harness();

    await expect(
      h.resolver.moveCheck(sessionPrincipal, 'check-1', 'org-destination'),
    ).resolves.toEqual({
      id: 'check-1',
      projectId: 'project-destination',
      organizationId: 'org-destination',
    });

    expect(h.workspaces.resolveForUser).toHaveBeenCalledWith('owner', {
      organizationId: 'org-destination',
      projectId: undefined,
    });
    expect(h.service.move).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-destination',
    );
  });

  it('keeps the legacy destination project selector working', async () => {
    const h = harness();

    await h.resolver.moveCheck(
      sessionPrincipal,
      'check-1',
      undefined,
      'project-destination',
    );

    expect(h.workspaces.resolveForUser).toHaveBeenCalledWith('owner', {
      organizationId: undefined,
      projectId: 'project-destination',
    });
    expect(h.service.move).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-destination',
    );
  });

  it.each([
    ['both', 'org-destination', 'project-destination'],
    ['neither', undefined, undefined],
  ])(
    'rejects %s move destinations with the stable XOR error',
    async (_label, destinationOrganizationId, destinationProjectId) => {
      const h = harness();

      await expect(
        h.resolver.moveCheck(
          sessionPrincipal,
          'check-1',
          destinationOrganizationId,
          destinationProjectId,
        ),
      ).rejects.toThrow('Provide exactly one of organizationId or projectId');

      expect(h.service.move).not.toHaveBeenCalled();
    },
  );
});

describe('ChecksResolver canonical slug privacy', () => {
  it('passes a project-scoped token binding into the canonical slug lookup', async () => {
    const h = harness();

    await h.resolver.checkByOrganizationSlug(principal, 'acme', 'api');

    expect(h.service.findByOrganizationSlug).toHaveBeenCalledWith(
      'owner',
      'acme',
      'api',
      'project-source',
    );
  });

  it('keeps account-session canonical slug lookup unbound', async () => {
    const h = harness();

    await h.resolver.checkByOrganizationSlug(sessionPrincipal, 'acme', 'api');

    expect(h.service.findByOrganizationSlug).toHaveBeenCalledWith(
      'owner',
      'acme',
      'api',
      undefined,
    );
  });
});

describe('ChecksResolver legacy slug privacy', () => {
  it('passes a project-scoped token binding into the legacy slug lookup', async () => {
    const h = harness();

    await h.resolver.checkBySlug(principal, 'acme', 'default', 'api');

    expect(h.service.findBySlug).toHaveBeenCalledWith(
      'owner',
      'acme',
      'default',
      'api',
      'project-source',
    );
  });

  it('keeps account-session legacy slug lookup unbound', async () => {
    const h = harness();

    await h.resolver.checkBySlug(sessionPrincipal, 'acme', 'default', 'api');

    expect(h.service.findBySlug).toHaveBeenCalledWith(
      'owner',
      'acme',
      'default',
      'api',
      undefined,
    );
  });
});

describe('ChecksResolver notificationChannelIds', () => {
  it('returns preloaded IDs without querying the service', () => {
    const h = harness();

    expect(
      h.resolver.notificationChannelIds({
        id: 'check-1',
        projectId: 'project-source',
        notificationChannelIds: [],
      } as never),
    ).toEqual([]);

    expect(h.service.effectiveNotificationChannelIds).not.toHaveBeenCalled();
  });

  it('falls back to the service for mutation return objects', async () => {
    const h = harness();

    await expect(
      h.resolver.notificationChannelIds({
        id: 'check-1',
        projectId: 'project-source',
      } as never),
    ).resolves.toEqual(['channel-fallback']);

    expect(h.service.effectiveNotificationChannelIds).toHaveBeenCalledWith(
      'check-1',
      'project-source',
    );
  });
});

describe('ChecksResolver mutation project binding', () => {
  it('passes the project authorized for setCheckChannelEnabled into the compare-and-set write', async () => {
    const h = harness();

    await h.resolver.setCheckChannelEnabled(
      principal,
      'check-1',
      'channel-1',
      false,
    );

    expect(h.service.projectIdForCheck).toHaveBeenCalledWith(
      'owner',
      'check-1',
    );
    expect(h.service.setCheckChannelEnabled).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-source',
      'channel-1',
      false,
    );
  });

  it('requires checks:write before toggling a channel', async () => {
    const h = harness();
    const readOnlyPrincipal: ApiPrincipal = {
      ...principal,
      apiToken: {
        ...principal.apiToken,
        capabilities: ['checks:read'],
      },
    };

    await expect(
      h.resolver.setCheckChannelEnabled(
        readOnlyPrincipal,
        'check-1',
        'channel-1',
        false,
      ),
    ).rejects.toThrow('Missing capability: checks:write');

    expect(h.service.setCheckChannelEnabled).not.toHaveBeenCalled();
  });

  it('passes the project authorized for updateCheck into the service write', async () => {
    const h = harness();
    const input = { name: 'Renamed' };

    await h.resolver.updateCheck(principal, 'check-1', input);

    expect(h.service.update).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-source',
      input,
    );
  });

  it('passes the project authorized for pauseCheck into the service write', async () => {
    const h = harness();

    await h.resolver.pauseCheck(principal, 'check-1');

    expect(h.service.pause).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-source',
    );
  });

  it('passes the project authorized for resumeCheck into the service write', async () => {
    const h = harness();

    await h.resolver.resumeCheck(principal, 'check-1');

    expect(h.service.resume).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-source',
    );
  });

  it('passes the project authorized for deleteCheck into the service write', async () => {
    const h = harness();

    await h.resolver.deleteCheck(principal, 'check-1');

    expect(h.service.delete).toHaveBeenCalledWith(
      'owner',
      'check-1',
      'project-source',
    );
  });
});
