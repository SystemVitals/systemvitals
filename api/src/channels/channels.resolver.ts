import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { ApiPrincipal } from '../tokens/api-principal';
import { ChannelsService } from './channels.service';
import { ChannelModel } from './channel.model';
import { EmailVerificationService } from './email-verification.service';

@Resolver(() => ChannelModel)
@UseGuards(ApiAuthGuard)
export class ChannelsResolver {
  constructor(
    private readonly channelsService: ChannelsService,
    private readonly emailVerificationService: EmailVerificationService,
  ) {}

  @Query(() => [ChannelModel])
  channels(
    @CurrentUser() user: ApiPrincipal,
    @Args('projectId', { type: () => ID }) projectId: string,
  ) {
    return this.channelsService.list(user.userId, projectId);
  }

  @Mutation(() => ChannelModel)
  createChannel(
    @CurrentUser() user: ApiPrincipal,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('type') type: string,
    @Args('configJson') configJson: string,
  ) {
    return this.channelsService.create(
      user.userId,
      projectId,
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
