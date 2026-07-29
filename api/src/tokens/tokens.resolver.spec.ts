import type { ApiPrincipal, ApiTokenPrincipal } from './api-principal';
import { PrismaService } from '../prisma/prisma.service';
import { ApiCredentialResolver } from './tokens.resolver';

function setup(project: unknown) {
  const findUnique = jest.fn().mockResolvedValue(project);
  const resolver = new ApiCredentialResolver({
    project: { findUnique },
  } as unknown as PrismaService);
  return { resolver, findUnique };
}

function apiTokenPrincipal(projectId: string | null): ApiTokenPrincipal {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    authKind: 'api-token',
    apiToken: {
      id: 'token-1',
      projectId,
      capabilities: ['checks:read', 'checks:write'],
      legacyScopes: [],
    },
  };
}

describe('ApiCredentialResolver', () => {
  it('returns canonical organization identity for a live scoped credential', async () => {
    const { resolver, findUnique } = setup({
      name: 'Default',
      organizationId: 'organization-1',
      organization: { name: 'Acme' },
    });

    await expect(
      resolver.apiCredential(apiTokenPrincipal('project-1')),
    ).resolves.toEqual({
      authKind: 'api-token',
      credentialMode: 'PROJECT_SCOPED',
      capabilities: ['checks:read', 'checks:write'],
      organizationId: 'organization-1',
      organizationName: 'Acme',
      projectId: 'project-1',
      projectName: 'Default',
    });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'project-1' },
      select: {
        name: true,
        organizationId: true,
        organization: { select: { name: true } },
      },
    });
  });

  it('returns nullable workspace identity for a session credential', async () => {
    const { resolver, findUnique } = setup(null);
    const principal: ApiPrincipal = {
      userId: 'user-1',
      email: 'user@example.com',
      authKind: 'session',
    };

    await expect(resolver.apiCredential(principal)).resolves.toEqual({
      authKind: 'session',
      credentialMode: 'SESSION',
      capabilities: [],
      organizationId: null,
      organizationName: null,
      projectId: null,
      projectName: null,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('keeps legacy broad credentials unscoped', async () => {
    const { resolver, findUnique } = setup(null);
    const principal = apiTokenPrincipal(null);
    principal.apiToken.capabilities = [];
    principal.apiToken.legacyScopes = ['write'];

    await expect(resolver.apiCredential(principal)).resolves.toEqual({
      authKind: 'api-token',
      credentialMode: 'LEGACY_BROAD',
      capabilities: ['checks:read', 'checks:write'],
      organizationId: null,
      organizationName: null,
      projectId: null,
      projectName: null,
    });
    expect(findUnique).not.toHaveBeenCalled();
  });
});
