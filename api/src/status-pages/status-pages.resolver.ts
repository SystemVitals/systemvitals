import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { StatusPagesService } from './status-pages.service';
import { StatusPageModel } from './status-page.model';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Resolver(() => StatusPageModel)
@UseGuards(ApiAuthGuard)
export class StatusPagesResolver {
  constructor(
    private readonly statusPagesService: StatusPagesService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  @Query(() => [StatusPageModel])
  async statusPages(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID, nullable: true })
    organizationId?: string,
    @Args('projectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use organizationId.',
    })
    projectId?: string,
  ) {
    const workspace = await this.workspacesService.resolveForUser(user.userId, {
      organizationId,
      projectId,
    });
    return this.statusPagesService.list(user.userId, workspace.projectId);
  }

  @Mutation(() => StatusPageModel)
  async createStatusPage(
    @CurrentUser() user: JwtUser,
    @Args('organizationId', { type: () => ID, nullable: true })
    organizationId: string | undefined,
    @Args('projectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use organizationId.',
    })
    projectId: string | undefined,
    @Args('slug') slug: string,
    @Args('title') title: string,
    @Args('checkIds', { type: () => [ID] }) checkIds: string[],
    @Args('brandingJson', { nullable: true }) brandingJson?: string,
  ) {
    const workspace = await this.workspacesService.resolveForUser(user.userId, {
      organizationId,
      projectId,
    });
    return this.statusPagesService.create(
      user.userId,
      workspace.projectId,
      slug,
      title,
      checkIds,
      brandingJson,
    );
  }

  @Mutation(() => StatusPageModel)
  updateStatusPage(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
    @Args('title', { nullable: true }) title?: string,
    @Args('checkIds', { type: () => [ID], nullable: true }) checkIds?: string[],
    @Args('brandingJson', { nullable: true }) brandingJson?: string,
  ) {
    return this.statusPagesService.update(user.userId, id, {
      title,
      checkIds,
      brandingJson,
    });
  }

  @Mutation(() => Boolean)
  deleteStatusPage(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.statusPagesService.delete(user.userId, id);
  }
}
