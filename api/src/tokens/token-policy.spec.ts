import { ForbiddenException } from '@nestjs/common';
import type { ApiPrincipal, ApiTokenMetadata } from './api-principal';
import { requireCheckAccess, requireOperationAccess } from './token-policy';

function sessionPrincipal(): ApiPrincipal {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    authKind: 'session',
  };
}

function apiTokenPrincipal(
  overrides: Partial<ApiTokenMetadata> = {},
): ApiPrincipal {
  return {
    userId: 'user-1',
    email: 'user@example.com',
    authKind: 'api-token',
    apiToken: {
      id: 'token-1',
      projectId: 'project-1',
      capabilities: ['checks:read', 'checks:write'],
      legacyScopes: [],
      ...overrides,
    },
  };
}

describe('requireCheckAccess', () => {
  it('allows session principals without scope or project checks', () => {
    expect(() =>
      requireCheckAccess(sessionPrincipal(), 'checks:write', 'project-2'),
    ).not.toThrow();
  });

  it('allows a scoped token with the capability for the requested project', () => {
    expect(() =>
      requireCheckAccess(
        apiTokenPrincipal({ capabilities: ['checks:read'] }),
        'checks:read',
        'project-1',
      ),
    ).not.toThrow();
  });

  it('rejects a scoped token used for a different project', () => {
    expect(() => {
      requireCheckAccess(
        apiTokenPrincipal({ capabilities: ['checks:read'] }),
        'checks:read',
        'project-2',
      );
    }).toThrow(
      new ForbiddenException('Credential is bound to a different project'),
    );
  });

  it('rejects a read-only token used for a check write', () => {
    expect(() => {
      requireCheckAccess(
        apiTokenPrincipal({ capabilities: ['checks:read'] }),
        'checks:write',
        'project-1',
      );
    }).toThrow(new ForbiddenException('Missing capability: checks:write'));
  });

  it('allows legacy read scope for check reads', () => {
    expect(() =>
      requireCheckAccess(
        apiTokenPrincipal({ capabilities: [], legacyScopes: ['read'] }),
        'checks:read',
        'project-1',
      ),
    ).not.toThrow();
  });

  it('allows legacy write scope for check reads and writes', () => {
    const principal = apiTokenPrincipal({
      capabilities: [],
      legacyScopes: ['write'],
    });

    expect(() =>
      requireCheckAccess(principal, 'checks:read', 'project-1'),
    ).not.toThrow();
    expect(() =>
      requireCheckAccess(principal, 'checks:write', 'project-1'),
    ).not.toThrow();
  });
});

describe('requireOperationAccess', () => {
  it.each([
    'apiCredential',
    'managedTelegramBot',
    'checks',
    'check',
    'checkBySlug',
    'checkByOrganizationSlug',
    'events',
    'nextExpectedAt',
    'notificationChannelIds',
    'createCheck',
    'createActiveCheck',
    'updateCheck',
    'setCheckChannelEnabled',
    'pauseCheck',
    'resumeCheck',
    'deleteCheck',
  ])('allows scoped tokens to resolve %s', (operationName) => {
    expect(() =>
      requireOperationAccess(apiTokenPrincipal(), operationName),
    ).not.toThrow();
  });

  it.each([
    'telegramConnectionPreview',
    'connectTelegramChannel',
    'moveCheck',
    'organizationCheckAllowance',
  ])(
    'allows sessions to resolve the session-only operation %s',
    (operationName) => {
      expect(() =>
        requireOperationAccess(sessionPrincipal(), operationName),
      ).not.toThrow();
    },
  );

  it.each([
    'telegramConnectionPreview',
    'connectTelegramChannel',
    'moveCheck',
    'organizationCheckAllowance',
  ])(
    'denies scoped API tokens from the session-only operation %s',
    (operationName) => {
      expect(() => {
        requireOperationAccess(apiTokenPrincipal(), operationName);
      }).toThrow(new ForbiddenException('Account session required'));
    },
  );

  it.each([
    'telegramConnectionPreview',
    'connectTelegramChannel',
    'moveCheck',
    'organizationCheckAllowance',
  ])(
    'denies legacy-broad API tokens from the session-only operation %s',
    (operationName) => {
      expect(() => {
        requireOperationAccess(
          apiTokenPrincipal({
            projectId: null,
            capabilities: [],
            legacyScopes: ['write'],
          }),
          operationName,
        );
      }).toThrow(new ForbiddenException('Account session required'));
    },
  );

  it.each([
    'me',
    'projects',
    'channels',
    'organizationMembers',
    'statusPages',
    'mySubscription',
    'apiTokens',
    'adminPing',
    'adminImpersonate',
  ])(
    'denies scoped tokens from the non-check operation %s',
    (operationName) => {
      expect(() => {
        requireOperationAccess(apiTokenPrincipal(), operationName);
      }).toThrow(
        new ForbiddenException(
          'Scoped credential cannot access this operation',
        ),
      );
    },
  );

  it.each([
    sessionPrincipal(),
    apiTokenPrincipal({
      projectId: null,
      capabilities: [],
      legacyScopes: ['write'],
    }),
  ])('preserves broad operation access for %#', (principal) => {
    expect(() => requireOperationAccess(principal, 'adminPing')).not.toThrow();
  });

  it('denies an API token that is neither scoped nor truly legacy broad', () => {
    expect(() => {
      requireOperationAccess(
        apiTokenPrincipal({
          projectId: null,
          capabilities: [],
          legacyScopes: [],
        }),
        'me',
      );
    }).toThrow(
      new ForbiddenException('Scoped credential cannot access this operation'),
    );
  });
});
