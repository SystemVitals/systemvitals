import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { ApiPrincipal } from '../tokens/api-principal';
import { ChannelsService } from './channels.service';
import { ChannelModel } from './channel.model';
import { EmailVerificationService } from './email-verification.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Resolver(() => ChannelModel)
@UseGuards(ApiAuthGuard)
export class ChannelsResolver {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly emailVerificationService: EmailVerificationService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  @Query(() => [ChannelModel])
  async channels(
    @CurrentUser() user: ApiPrincipal,
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
    return this.channelsService.list(user.userId, workspace.projectId);
  }

  @Mutation(() => ChannelModel)
  async createChannel(
    @CurrentUser() user: ApiPrincipal,
    @Args('organizationId', { type: () => ID, nullable: true })
    organizationId: string | undefined,
    @Args('projectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use organizationId.',
    })
    projectId: string | undefined,
    @Args('type') type: string,
    @Args('configJson') configJson: string,
  ) {
    const workspace = await this.workspacesService.resolveForUser(user.userId, {
      organizationId,
      projectId,
    });
    return this.channelsService.create(
      user.userId,
      workspace.projectId,
      type,
      configJson,
    );
  }

  @Mutation(() => Boolean)
  deleteChannel(
    @CurrentUser() user: ApiPrincipal,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.channelsService.delete(user.userId, id);
  }

  @Mutation(() => ChannelModel)
  resendEmailChannelVerification(
    @CurrentUser() user: ApiPrincipal,
    @Args('channelId', { type: () => ID }) channelId: string,
  ) {
    return this.emailVerificationService.resend(user.userId, channelId);
  }
}
