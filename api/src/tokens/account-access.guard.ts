import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { ApiPrincipal } from './api-principal';
import { ApiAuthGuard } from './api-auth.guard';
import { isAccountToken } from './token-policy';

@Injectable()
export class AccountAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request =
      context.getType<'graphql'>() === 'graphql'
        ? GqlExecutionContext.create(context).getContext<{
            req: { user?: ApiPrincipal };
          }>().req
        : context.switchToHttp().getRequest<{ user?: ApiPrincipal }>();
    const principal = request.user;
    if (principal?.impersonatedBy) {
      throw new ForbiddenException('Account session required');
    }
    if (
      !principal ||
      (principal.authKind !== 'session' && !isAccountToken(principal))
    ) {
      throw new ForbiddenException(
        'Account session or personal access token required',
      );
    }
    return true;
  }
}

export function AccountAccess(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(ApiAuthGuard, AccountAccessGuard));
}
