import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtUser } from '../auth/jwt.strategy';

interface RequestWithUser {
  user?: JwtUser;
}

interface GqlContext {
  req?: RequestWithUser;
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let req: RequestWithUser | undefined;
    if (context.getType<'graphql' | 'http'>() === 'graphql') {
      const gqlCtx =
        GqlExecutionContext.create(context).getContext<GqlContext>();
      req = gqlCtx.req;
    } else {
      req = context.switchToHttp().getRequest<RequestWithUser>();
    }
    const jwtUser = req?.user;
    if (!jwtUser?.userId) throw new ForbiddenException('Admin access required');
    const user = await this.prisma.user.findUnique({
      where: { id: jwtUser.userId },
      select: { isAdmin: true, suspendedAt: true },
    });
    if (!user || !user.isAdmin || user.suspendedAt) {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}
