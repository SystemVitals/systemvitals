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

describe('ChecksResolver mutation project binding', () => {
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
