import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AccountAccessGuard } from './account-access.guard';

function context(user: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AccountAccessGuard', () => {
  const guard = new AccountAccessGuard();
  const user = { userId: 'u1', email: 'agent@example.test' };
  const token = {
    ...user,
    authKind: 'api-token',
    apiToken: {
      id: 't1',
      projectId: null,
      capabilities: ['account:manage'],
      legacyScopes: [],
    },
  };
  it.each([{ ...user, authKind: 'session' }, token])(
    'allows account access %#',
    (principal) => {
      expect(guard.canActivate(context(principal))).toBe(true);
    },
  );
  it.each([
    undefined,
    { ...user, authKind: 'session', impersonatedBy: 'admin1' },
    { ...token, impersonatedBy: 'admin1' },
    {
      ...token,
      apiToken: {
        ...token.apiToken,
        capabilities: [],
        legacyScopes: ['write'],
      },
    },
    { ...token, apiToken: { ...token.apiToken, projectId: 'p1' } },
  ])('rejects credentials without account authority %#', (principal) => {
    expect(() => guard.canActivate(context(principal))).toThrow(
      ForbiddenException,
    );
  });
});
