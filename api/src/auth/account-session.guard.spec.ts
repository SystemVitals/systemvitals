import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { NonImpersonatedSessionGuard } from './account-session.guard';

function contextWithUser(user: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe('NonImpersonatedSessionGuard', () => {
  const guard = new NonImpersonatedSessionGuard();

  it('allows a normal authenticated session user', () => {
    expect(
      guard.canActivate(
        contextWithUser({
          userId: 'user-1',
          email: 'user@example.test',
        }),
      ),
    ).toBe(true);
  });

  it('rejects an impersonated session without exposing claim details', () => {
    expect(() =>
      guard.canActivate(
        contextWithUser({
          userId: 'user-1',
          email: 'user@example.test',
          impersonatedBy: 'admin-1',
        }),
      ),
    ).toThrow(new ForbiddenException('Account session required'));
  });
});
