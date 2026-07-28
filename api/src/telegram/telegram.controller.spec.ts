import { UnauthorizedException } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import type { TelegramBotClient } from './telegram-bot.client';
import { TelegramConnectionsService } from './telegram-connections.service';
import { TelegramController } from './telegram.controller';
import { TelegramModule } from './telegram.module';
import * as telegramUpdate from './telegram-update';

const SYNTHETIC_SECRET_HEADER = 'synthetic-webhook-header';
const CONFIGURED_USERNAME = 'SyntheticConfiguredBot';

const VALID_PAYLOAD = {
  update_id: 501,
  message: {
    text: '/start@SyntheticConfiguredBot',
    message_thread_id: 77,
    chat: {
      id: -1007654321,
      type: 'supergroup',
      title: 'Synthetic Destination',
    },
  },
};

function makeController() {
  const assertWebhookSecret = jest.fn();
  const getPublicBot = jest.fn().mockResolvedValue({
    available: true,
    id: 'synthetic-bot-id',
    username: CONFIGURED_USERNAME,
  });
  const telegramBot = {
    assertWebhookSecret,
    getPublicBot,
  } as unknown as TelegramBotClient;
  const handleStart = jest.fn().mockResolvedValue(undefined);
  const connections = { handleStart } as unknown as TelegramConnectionsService;

  return {
    controller: new TelegramController(telegramBot, connections),
    assertWebhookSecret,
    getPublicBot,
    handleStart,
  };
}

describe('TelegramController', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('checks the webhook secret first and propagates unauthorized without further work', async () => {
    const { controller, assertWebhookSecret, getPublicBot, handleStart } =
      makeController();
    const parse = jest.spyOn(telegramUpdate, 'parseTelegramStartUpdate');
    const unauthorized = new UnauthorizedException('Invalid synthetic webhook');
    assertWebhookSecret.mockImplementation(() => {
      throw unauthorized;
    });

    await expect(controller.webhook(undefined, VALID_PAYLOAD)).rejects.toBe(
      unauthorized,
    );

    expect(assertWebhookSecret).toHaveBeenCalledWith(undefined);
    expect(getPublicBot).not.toHaveBeenCalled();
    expect(parse).not.toHaveBeenCalled();
    expect(handleStart).not.toHaveBeenCalled();
  });

  it('checks the secret before retrieving bot identity', async () => {
    const { controller, assertWebhookSecret, getPublicBot } = makeController();

    await controller.webhook(SYNTHETIC_SECRET_HEADER, VALID_PAYLOAD);

    expect(assertWebhookSecret).toHaveBeenCalledTimes(1);
    expect(getPublicBot).toHaveBeenCalledTimes(1);
    expect(assertWebhookSecret.mock.invocationCallOrder[0]).toBeLessThan(
      getPublicBot.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['unavailable bot', { available: false, id: null, username: null }],
    [
      'available bot without username',
      { available: true, id: 'synthetic-bot-id', username: null },
    ],
  ])(
    'acknowledges an authenticated request for an %s without parsing',
    async (_case, publicBot) => {
      const { controller, assertWebhookSecret, getPublicBot, handleStart } =
        makeController();
      const parse = jest.spyOn(telegramUpdate, 'parseTelegramStartUpdate');
      getPublicBot.mockResolvedValue(publicBot);

      await expect(
        controller.webhook(SYNTHETIC_SECRET_HEADER, VALID_PAYLOAD),
      ).resolves.toEqual({ ok: true });

      expect(assertWebhookSecret).toHaveBeenCalledWith(SYNTHETIC_SECRET_HEADER);
      expect(getPublicBot).toHaveBeenCalledTimes(1);
      expect(parse).not.toHaveBeenCalled();
      expect(handleStart).not.toHaveBeenCalled();
    },
  );

  it('acknowledges malformed authenticated payload without starting a challenge', async () => {
    const { controller, handleStart } = makeController();
    const parse = jest.spyOn(telegramUpdate, 'parseTelegramStartUpdate');
    const malformedPayload = {
      update_id: 502,
      message: {
        text: '/help',
        chat: { id: 123456, type: 'private' },
      },
    };

    await expect(
      controller.webhook(SYNTHETIC_SECRET_HEADER, malformedPayload),
    ).resolves.toEqual({ ok: true });

    expect(parse).toHaveBeenCalledWith(malformedPayload, CONFIGURED_USERNAME);
    expect(handleStart).not.toHaveBeenCalled();
  });

  it('parses with the exact configured username and handles one valid start', async () => {
    const { controller, handleStart } = makeController();
    const parse = jest.spyOn(telegramUpdate, 'parseTelegramStartUpdate');

    await expect(
      controller.webhook(SYNTHETIC_SECRET_HEADER, VALID_PAYLOAD),
    ).resolves.toEqual({ ok: true });

    expect(parse).toHaveBeenCalledWith(VALID_PAYLOAD, CONFIGURED_USERNAME);
    expect(handleStart).toHaveBeenCalledTimes(1);
    expect(handleStart).toHaveBeenCalledWith({
      updateId: '501',
      chatId: '-1007654321',
      chatType: 'supergroup',
      chatTitle: 'Synthetic Destination',
      messageThreadId: 77,
    });
  });
});

describe('TelegramModule', () => {
  it('registers the webhook controller and challenge service', () => {
    const controllerMetadata: unknown = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      TelegramModule,
    );
    const providerMetadata: unknown = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      TelegramModule,
    );
    const controllers = Array.isArray(controllerMetadata)
      ? (controllerMetadata as unknown[])
      : [];
    const providers = Array.isArray(providerMetadata)
      ? (providerMetadata as unknown[])
      : [];

    expect(controllers).toContain(TelegramController);
    expect(providers).toContain(TelegramConnectionsService);
  });
});
