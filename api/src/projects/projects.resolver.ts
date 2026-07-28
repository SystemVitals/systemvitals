import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { ProjectsService } from './projects.service';
import { ProjectModel } from '../common/models';

@Resolver(() => ProjectModel)
@UseGuards(ApiAuthGuard)
export class ProjectsResolver {
  constructor(private readonly projectsService: ProjectsService) {}

  @Query(() => [ProjectModel])
  projects(@CurrentUser() user: JwtUser) {
    return this.projectsService.listForUser(user.userId);
  }

  @Mutation(() => ProjectModel)
  createProject(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID }) organizationId: string,
    @Args('name') name: string,
  ) {
    return this.projectsService.create(user.userId, organizationId, name);
  }

  @Mutation(() => ProjectModel)
  regeneratePingKey(
    @CurrentUser() user: JwtUser,
    @Args('projectId', { type: () => ID }) projectId: string,
  ) {
    return this.projectsService.regeneratePingKey(user.userId, projectId);
  }
}
