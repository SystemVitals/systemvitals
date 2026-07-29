import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { UserModel, OrganizationModel } from '../common/models';
import { OrganizationsService } from './organizations.service';

@Resolver(() => UserModel)
@UseGuards(ApiAuthGuard)
export class OrganizationsResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationsService: OrganizationsService,
  ) {}

  @Query(() => UserModel)
  async me(@CurrentUser() user: JwtUser): Promise<UserModel> {
    const dbUser = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.userId },
      include: {
        memberships: {
          include: {
            organization: {
              include: {
                projects: true,
                creator: { include: { subscription: true } },
              },
            },
          },
        },
      },
    });
    return {
      id: dbUser.id,
      email: dbUser.email,
      isAdmin: dbUser.isAdmin,
      hasPassword: dbUser.passwordHash !== null,
      googleLinked: dbUser.googleId !== null,
      organizations: dbUser.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        pingKey: m.organization.projects[0].pingKey,
        role: m.role,
        plan: m.organization.creator.subscription?.plan ?? 'SOLO',
        creatorUserId: m.organization.creatorUserId,
        creatorLabel: m.organization.creator.email,
        projects: m.organization.projects.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          pingKey: p.pingKey,
          organizationId: p.organizationId,
        })),
      })),
    };
  }

  @Mutation(() => OrganizationModel)
  createOrganization(@CurrentUser() user: JwtUser, @Args('name') name: string) {
    return this.organizationsService.create(user.userId, name);
  }

  @Mutation(() => OrganizationModel)
  updateOrganization(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
    @Args('name', { nullable: true }) name?: string,
    @Args('slug', { nullable: true }) slug?: string,
  ) {
    return this.organizationsService.update(user.userId, organizationId, {
      name,
      slug,
    });
  }

  @Mutation(() => OrganizationModel)
  updateOrganizationSlug(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
    @Args('slug') slug: string,
  ) {
    return this.organizationsService.updateSlug(
      user.userId,
      organizationId,
      slug,
    );
  }

  @Mutation(() => OrganizationModel)
  transferOrganizationCreatorship(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
    @Args('newCreatorUserId', { type: () => ID }) newCreatorUserId: string,
  ) {
    return this.organizationsService.transferCreatorship(
      user.userId,
      organizationId,
      newCreatorUserId,
    );
  }

  @Mutation(() => Boolean)
  deleteOrganization(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
  ) {
    return this.organizationsService.remove(user.userId, organizationId);
  }
}
