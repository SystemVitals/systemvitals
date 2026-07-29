import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { ProjectsService } from './projects.service';
import { OrganizationModel, ProjectModel } from '../common/models';

@Resolver(() => ProjectModel)
@UseGuards(ApiAuthGuard)
export class ProjectsResolver {
  constructor(private readonly projectsService: ProjectsService) {}

  @Query(() => [ProjectModel], {
    deprecationReason: 'Organizations now contain one implicit workspace.',
  })
  projects(@CurrentUser() user: JwtUser) {
    return this.projectsService.listForUser(user.userId);
  }

  @Mutation(() => OrganizationModel)
  regenerateOrganizationPingKey(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
  ) {
    return this.projectsService.regenerateOrganizationPingKey(
      user.userId,
      organizationId,
    );
  }

  @Mutation(() => ProjectModel, {
    deprecationReason: 'Use regenerateOrganizationPingKey.',
  })
  regeneratePingKey(
    @CurrentUser() user: JwtUser,
    @Args('projectId', { type: () => ID }) projectId: string,
  ) {
    return this.projectsService.regeneratePingKey(user.userId, projectId);
  }
}
