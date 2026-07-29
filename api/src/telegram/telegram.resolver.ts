import { UseGuards } from '@nestjs/common';
import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { AccountSessionOnly } from '../auth/account-session.guard';
import type { JwtUser } from '../auth/jwt.strategy';
import { CurrentUser } from '../common/current-user.decorator';
import { ChannelModel } from '../channels/channel.model';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { TelegramBotClient } from './telegram-bot.client';
import { TelegramConnectionsService } from './telegram-connections.service';
import {
  ManagedTelegramBotModel,
  TelegramConnectionPreviewModel,
} from './telegram.model';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Resolver()
@UseGuards(ApiAuthGuard)
export class TelegramResolver {
  constructor(
    private readonly telegramBot: TelegramBotClient,
    private readonly telegramConnections: TelegramConnectionsService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  @Query(() => ManagedTelegramBotModel)
  async managedTelegramBot(): Promise<ManagedTelegramBotModel> {
    const bot = await this.telegramBot.getPublicBot();
    return { available: bot.available, username: bot.username };
  }

  @Query(() => TelegramConnectionPreviewModel)
  @AccountSessionOnly()
  telegramConnectionPreview(@Args('token') token: string) {
    return this.telegramConnections.preview(token);
  }

  @Mutation(() => ChannelModel)
  @AccountSessionOnly()
  async connectTelegramChannel(
    @CurrentUser() user: JwtUser,
    @Args('token') token: string,
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
    return this.telegramConnections.connect(
      user.userId,
      token,
      workspace.projectId,
    );
  }
}
