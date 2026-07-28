import {
  applyDecorators,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { JwtUser } from './jwt.strategy';
import { JwtAuthGuard } from './jwt-auth.guard';

interface RequestWithUser {
  user?: JwtUser;
}

@Injectable()
export class NonImpersonatedSessionGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request =
      context.getType<'graphql'>() === 'graphql'
        ? (GqlExecutionContext.create(context).getContext()
            .req as RequestWithUser) // eslint-disable-line @typescript-eslint/no-unsafe-member-access
        : context.switchToHttp().getRequest<RequestWithUser>();

    if (!request.user || request.user.impersonatedBy) {
      throw new ForbiddenException('Account session required');
    }

    return true;
  }
}

export function AccountSessionOnly(): MethodDecorator & ClassDecorator {
  return applyDecorators(UseGuards(JwtAuthGuard, NonImpersonatedSessionGuard));
}
