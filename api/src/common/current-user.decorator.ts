import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { ApiPrincipal } from '../tokens/api-principal';

interface RequestWithUser {
  user: ApiPrincipal;
}

function gqlReq(context: ExecutionContext): RequestWithUser {
  // GqlExecutionContext.getContext() is typed as `any` in the library
  /* eslint-disable @typescript-eslint/no-unsafe-member-access */
  return GqlExecutionContext.create(context).getContext()
    .req as RequestWithUser;
  /* eslint-enable @typescript-eslint/no-unsafe-member-access */
}

export const CurrentUser = createParamDecorator(
  (_data, context: ExecutionContext): ApiPrincipal => {
    if (context.getType<'graphql'>() === 'graphql') {
      return gqlReq(context).user;
    }
    return context.switchToHttp().getRequest<RequestWithUser>().user;
  },
);
