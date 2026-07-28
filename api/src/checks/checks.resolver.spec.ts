import type { ApiPrincipal } from '../tokens/api-principal';
import { ChecksResolver } from './checks.resolver';
import type { ChecksService } from './checks.service';

const principal: ApiPrincipal = {
  userId: 'owner',
  email: 'owner@example.test',
  authKind: 'api-token',
  apiToken: {
    id: 'token',
    projectId: 'project-source',
    capabilities: ['checks:write'],
    legacyScopes: [],
  },
};

function harness() {
  const service = {
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
  return {
    service,
    resolver: new ChecksResolver(service as unknown as ChecksService),
  };
}

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
