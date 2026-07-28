import { UnauthorizedException } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { TelegramBotClient } from '../src/telegram/telegram-bot.client';

process.env.DATABASE_URL ??=
  'postgresql://synthetic_test:synthetic_test@127.0.0.1:5432/systemvitals_test';
process.env.JWT_SECRET ??= 'synthetic-test-jwt-secret-at-least-32-characters';
process.env.NODE_ENV = 'test';

jest.mock('../src/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

const WEBHOOK_PATH = '/integrations/telegram/webhook';
const SYNTHETIC_SECRET = 'synthetic_webhook_secret';
const MALFORMED_JSON = '{"update_id":';

describe('Telegram webhook pre-parser authentication (e2e)', () => {
  let app: NestFastifyApplication;
  let assertWebhookSecret: jest.SpiedFunction<
    TelegramBotClient['assertWebhookSecret']
  >;
  let getPublicBot: jest.SpiedFunction<TelegramBotClient['getPublicBot']>;

  beforeAll(async () => {
    jest
      .spyOn(TelegramBotClient.prototype, 'onModuleInit')
      .mockResolvedValue(undefined);
    assertWebhookSecret = jest
      .spyOn(TelegramBotClient.prototype, 'assertWebhookSecret')
      .mockImplementation((candidate) => {
        if (candidate !== SYNTHETIC_SECRET) {
          throw new UnauthorizedException('Invalid Telegram webhook');
        }
      });
    getPublicBot = jest
      .spyOn(TelegramBotClient.prototype, 'getPublicBot')
      .mockResolvedValue({ available: false, id: null, username: null });

    const { buildApp } =
      jest.requireActual<typeof import('../src/main')>('../src/main');
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => {
    assertWebhookSecret.mockClear();
    getPublicBot.mockClear();
  });

  afterAll(async () => {
    await app?.close();
    jest.restoreAllMocks();
  });

  it.each([
    ['missing', undefined],
    ['wrong', 'wrong_synthetic_secret'],
  ])(
    'rejects a %s secret before malformed JSON parsing',
    async (_label, secret) => {
      const response = await app.inject({
        method: 'POST',
        url: WEBHOOK_PATH,
        headers: {
          'content-type': 'application/json',
          ...(secret === undefined
            ? {}
            : { 'x-telegram-bot-api-secret-token': secret }),
        },
        payload: MALFORMED_JSON,
      });

      expect(response.statusCode).toBe(401);
      expect(assertWebhookSecret).toHaveBeenCalledTimes(1);
      expect(getPublicBot).not.toHaveBeenCalled();
    },
  );

  it('allows an authenticated malformed request to reach JSON parsing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: WEBHOOK_PATH,
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': SYNTHETIC_SECRET,
      },
      payload: MALFORMED_JSON,
    });

    expect(response.statusCode).toBe(400);
    expect(assertWebhookSecret).toHaveBeenCalledTimes(1);
    expect(getPublicBot).not.toHaveBeenCalled();
  });

  it('authenticates the exact webhook route once before the controller defense', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${WEBHOOK_PATH}?source=telegram`,
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': SYNTHETIC_SECRET,
      },
      payload: { update_id: 123 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(assertWebhookSecret).toHaveBeenCalledTimes(2);
    expect(getPublicBot).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['GET webhook path', 'GET', WEBHOOK_PATH],
    ['neighboring path', 'POST', `${WEBHOOK_PATH}/extra`],
    ['ordinary route', 'POST', '/graphql'],
  ] as const)(
    'does not apply webhook authentication to the %s',
    async (_label, method, url) => {
      const response = await app.inject({
        method,
        url,
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'wrong_synthetic_secret',
        },
        payload: method === 'POST' ? MALFORMED_JSON : undefined,
      });

      expect(response.statusCode).not.toBe(401);
      expect(assertWebhookSecret).not.toHaveBeenCalled();
      expect(getPublicBot).not.toHaveBeenCalled();
    },
  );
});
