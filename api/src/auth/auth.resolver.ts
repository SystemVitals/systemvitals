import { Args, Mutation, Resolver } from '@nestjs/graphql';
import { NotFoundException, UseGuards } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { CurrentUser } from '../common/current-user.decorator';
import { AuthService } from './auth.service';
import { SetPasswordArgs } from './dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { JwtUser } from './jwt.strategy';

/**
 * Deliberately guarded with JwtAuthGuard rather than the ApiAuthGuard used by
 * the other resolvers: an ApiToken must not be able to change the password of
 * the account it belongs to.
 */
@Resolver()
@UseGuards(JwtAuthGuard)
export class AuthResolver {
  constructor(private readonly auth: AuthService) {}

  @Mutation(() => Boolean)
  async setPassword(
    @CurrentUser() user: JwtUser,
    @Args() args: SetPasswordArgs,
  ): Promise<boolean> {
    try {
      return await this.auth.setPassword(
        user.userId,
        args.newPassword,
        args.currentPassword,
      );
    } catch (e) {
      // AuthService.setPassword uses findUniqueOrThrow; userId comes from a
      // validated JWT so this should be unreachable in practice, but a raw
      // Prisma "record not found" error must never reach a GraphQL response.
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2025'
      ) {
        throw new NotFoundException('User not found');
      }
      throw e;
    }
  }
}
