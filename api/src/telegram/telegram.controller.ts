import { Body, Controller, Headers, HttpCode, Post } from '@nestjs/common';
import { TelegramBotClient } from './telegram-bot.client';
import { TelegramConnectionsService } from './telegram-connections.service';
import { parseTelegramStartUpdate } from './telegram-update';

@Controller('integrations/telegram')
export class TelegramController {
  constructor(
    private readonly telegramBot: TelegramBotClient,
    private readonly connections: TelegramConnectionsService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() payload: unknown,
  ): Promise<{ ok: true }> {
    this.telegramBot.assertWebhookSecret(secret);

    const publicBot = await this.telegramBot.getPublicBot();
    if (!publicBot.available || publicBot.username === null) {
      return { ok: true };
    }

    const update = parseTelegramStartUpdate(payload, publicBot.username);
    if (update === null) {
      return { ok: true };
    }

    await this.connections.handleStart(update);
    return { ok: true };
  }
}
