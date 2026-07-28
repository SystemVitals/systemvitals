// api-auth.guard.ts
// NOTE: This guard depends on the 'api' passport strategy, which is registered
// exclusively by TokensCoreModule. AppModule reaches it through TokensModule,
// while AdminModule imports the core directly without registering the public
// TokensResolver.
import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { GraphQLResolveInfo } from 'graphql';
import type { ApiPrincipal } from './api-principal';
import { requireOperationAccess } from './token-policy';

@Injectable()
export class ApiAuthGuard extends AuthGuard('api') {
  handleRequest<TUser = ApiPrincipal>(
    err: Error | null,
    user: ApiPrincipal | false | null,
    _info: unknown,
    context: ExecutionContext,
  ): TUser {
    if (err) throw err;
    if (!user) throw new UnauthorizedException();

    if (context.getType<'graphql'>() === 'graphql') {
      const operationName =
        GqlExecutionContext.create(context).getInfo<GraphQLResolveInfo>()
          .fieldName;
      requireOperationAccess(user, operationName);
    }

    return user as TUser;
  }

  getRequest(context: ExecutionContext): unknown {
    if (context.getType<'graphql'>() === 'graphql') {
      // GqlExecutionContext.getContext() is typed as `any` in the library
      /* eslint-disable @typescript-eslint/no-unsafe-member-access */
      return GqlExecutionContext.create(context).getContext().req as unknown;
      /* eslint-enable @typescript-eslint/no-unsafe-member-access */
    }
    return context.switchToHttp().getRequest<unknown>();
  }
}
