import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TokensCoreModule } from '../tokens/tokens-core.module';
import { TELEGRAM_FETCH, TelegramBotClient } from './telegram-bot.client';
import { TelegramConnectionsService } from './telegram-connections.service';
import { TelegramController } from './telegram.controller';
import { TelegramResolver } from './telegram.resolver';

export { TELEGRAM_FETCH };

@Module({
  imports: [AuthModule, TokensCoreModule],
  providers: [
    {
      provide: TELEGRAM_FETCH,
      useValue: globalThis.fetch.bind(globalThis),
    },
    TelegramBotClient,
    TelegramConnectionsService,
    TelegramResolver,
  ],
  controllers: [TelegramController],
  exports: [TelegramBotClient],
})
export class TelegramModule {}
