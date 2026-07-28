import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import type {
  ManagedTelegramBot,
  TelegramApiEnvelope,
  TelegramFetch,
  TelegramMessageResult,
  TelegramUser,
} from './telegram.types';

export const TELEGRAM_FETCH = Symbol('TELEGRAM_FETCH');

const UNAVAILABLE_BOT: ManagedTelegramBot = {
  available: false,
  id: null,
  username: null,
};
const INITIALIZATION_RETRY_MS = 60_000;

interface TelegramConfiguration {
  botToken: string;
  webhookSecret: string;
  webhookUrl: string;
}

type ValidatedTelegramUser = TelegramUser & { username: string };
type TelegramMethod = 'getMe' | 'setWebhook' | 'sendMessage';

@Injectable()
export class TelegramBotClient implements OnModuleInit {
  private readonly logger = new Logger(TelegramBotClient.name);
  private readonly configuration: TelegramConfiguration | null;
  private publicBot: ManagedTelegramBot = { ...UNAVAILABLE_BOT };
  private lastInitializationAttemptAt: number | null = null;
  private initializationPromise: Promise<void> | null = null;

  constructor(
    configService: ConfigService,
    @Inject(TELEGRAM_FETCH)
    private readonly telegramFetch: TelegramFetch,
  ) {
    const botToken =
      configService.get<string>('TELEGRAM_BOT_TOKEN')?.trim() ?? '';
    const webhookSecret =
      configService.get<string>('TELEGRAM_WEBHOOK_SECRET')?.trim() ?? '';
    const webhookUrl =
      configService.get<string>('TELEGRAM_WEBHOOK_URL')?.trim() ?? '';
    this.configuration =
      botToken && webhookSecret && webhookUrl
        ? { botToken, webhookSecret, webhookUrl }
        : null;
  }

  async onModuleInit(): Promise<void> {
    await this.initializeSafely();
  }

  async getPublicBot(): Promise<ManagedTelegramBot> {
    if (this.initializationPromise) {
      await this.initializationPromise;
    } else if (
      this.configuration &&
      !this.publicBot.available &&
      (this.lastInitializationAttemptAt === null ||
        Date.now() - this.lastInitializationAttemptAt >=
          INITIALIZATION_RETRY_MS)
    ) {
      await this.initializeSafely();
    }

    return { ...this.publicBot };
  }

  assertWebhookSecret(candidate: string | undefined): void {
    if (!this.configuration || candidate === undefined) {
      throw new UnauthorizedException('Invalid Telegram webhook');
    }

    const expectedDigest = createHash('sha256')
      .update(this.configuration.webhookSecret)
      .digest();
    const candidateDigest = createHash('sha256').update(candidate).digest();
    if (!timingSafeEqual(expectedDigest, candidateDigest)) {
      throw new UnauthorizedException('Invalid Telegram webhook');
    }
  }

  async sendMessage(input: {
    chatId: string;
    text: string;
    messageThreadId?: number;
  }): Promise<TelegramMessageResult> {
    const body: Record<string, unknown> = {
      chat_id: input.chatId,
      text: input.text,
    };
    if (input.messageThreadId !== undefined) {
      body.message_thread_id = input.messageThreadId;
    }

    return this.call('sendMessage', body);
  }

  private async initializeSafely(): Promise<void> {
    if (!this.configuration) {
      this.publicBot = { ...UNAVAILABLE_BOT };
      return;
    }
    if (this.initializationPromise) {
      await this.initializationPromise;
      return;
    }

    const attempt = this.initialize();
    this.initializationPromise = attempt;
    try {
      await attempt;
    } finally {
      if (this.initializationPromise === attempt) {
        this.initializationPromise = null;
      }
    }
  }

  private async initialize(): Promise<void> {
    const configuration = this.configuration;
    if (!configuration) {
      this.publicBot = { ...UNAVAILABLE_BOT };
      return;
    }

    this.lastInitializationAttemptAt = Date.now();
    try {
      const bot = await this.call('getMe', {});
      await this.call('setWebhook', {
        url: configuration.webhookUrl,
        allowed_updates: ['message', 'channel_post'],
        secret_token: configuration.webhookSecret,
      });
      this.publicBot = {
        available: true,
        id: String(bot.id),
        username: bot.username,
      };
    } catch (error) {
      this.publicBot = { ...UNAVAILABLE_BOT };
      this.logger.error(this.initializationErrorMessage(error));
    }
  }

  private initializationErrorMessage(error: unknown): string {
    if (
      error instanceof Error &&
      (error.message === 'Telegram getMe failed' ||
        error.message === 'Telegram setWebhook failed')
    ) {
      return error.message;
    }
    return 'Telegram initialization failed';
  }

  private async call(
    method: 'getMe',
    body: Record<string, unknown>,
  ): Promise<ValidatedTelegramUser>;
  private async call(
    method: 'setWebhook',
    body: Record<string, unknown>,
  ): Promise<true>;
  private async call(
    method: 'sendMessage',
    body: Record<string, unknown>,
  ): Promise<TelegramMessageResult>;
  private async call(
    method: TelegramMethod,
    body: Record<string, unknown>,
  ): Promise<ValidatedTelegramUser | true | TelegramMessageResult> {
    const failure = (): Error => new Error(`Telegram ${method} failed`);
    if (!this.configuration) {
      throw failure();
    }

    let apiResponse: Response;
    try {
      apiResponse = await this.telegramFetch(
        `https://api.telegram.org/bot${this.configuration.botToken}/${method}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw failure();
    }

    if (!apiResponse.ok) {
      throw failure();
    }

    let parsed: unknown;
    try {
      parsed = await apiResponse.json();
    } catch {
      throw failure();
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw failure();
    }

    const envelope = parsed as TelegramApiEnvelope<unknown>;
    if (envelope.ok !== true || envelope.result === undefined) {
      throw failure();
    }
    return this.validateResult(method, envelope.result);
  }

  private validateResult(
    method: TelegramMethod,
    result: unknown,
  ): ValidatedTelegramUser | true | TelegramMessageResult {
    const failure = (): Error => new Error(`Telegram ${method} failed`);

    if (method === 'setWebhook') {
      if (result !== true) {
        throw failure();
      }
      return true;
    }

    if (!this.isRecord(result)) {
      throw failure();
    }

    if (method === 'getMe') {
      if (
        !this.isFiniteSafeInteger(result.id) ||
        result.is_bot !== true ||
        typeof result.username !== 'string'
      ) {
        throw failure();
      }
      const username = result.username.trim();
      if (!username) {
        throw failure();
      }
      return {
        id: result.id,
        is_bot: true,
        username,
      };
    }

    if (!this.isFiniteSafeInteger(result.message_id)) {
      throw failure();
    }
    return { message_id: result.message_id };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isFiniteSafeInteger(value: unknown): value is number {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Number.isSafeInteger(value)
    );
  }
}
