import { Injectable, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@nestjs/graphql';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext): unknown {
    if (context.getType<'graphql'>() === 'graphql') {
      // GqlExecutionContext.getContext() returns `any` — type-safe extraction below

      return GqlExecutionContext.create(context).getContext().req; // eslint-disable-line @typescript-eslint/no-unsafe-member-access
    }
    return context.switchToHttp().getRequest<unknown>();
  }
}
