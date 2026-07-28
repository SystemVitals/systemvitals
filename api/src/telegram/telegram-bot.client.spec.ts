import { Logger, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TelegramBotClient } from './telegram-bot.client';
import type {
  TelegramApiEnvelope,
  TelegramFetch,
  TelegramUser,
} from './telegram.types';

const TELEGRAM_CONFIG = {
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_WEBHOOK_SECRET: 'test_webhook_secret',
  TELEGRAM_WEBHOOK_URL:
    'https://api.example.test/integrations/telegram/webhook',
} as const;

const BOT_API_ROOT = 'https://api.telegram.org/bottest-token';

const INCOMPLETE_TELEGRAM_CONFIGS = [
  [
    'token only',
    {
      TELEGRAM_BOT_TOKEN: TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN,
    },
  ],
  [
    'token and URL without secret',
    {
      TELEGRAM_BOT_TOKEN: TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN,
      TELEGRAM_WEBHOOK_URL: TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_URL,
    },
  ],
  [
    'secret and URL without token',
    {
      TELEGRAM_WEBHOOK_SECRET: TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_SECRET,
      TELEGRAM_WEBHOOK_URL: TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_URL,
    },
  ],
  [
    'whitespace-only values',
    {
      TELEGRAM_BOT_TOKEN: '   ',
      TELEGRAM_WEBHOOK_SECRET: '   ',
      TELEGRAM_WEBHOOK_URL: '   ',
    },
  ],
] as const;

function response<T>(envelope: TelegramApiEnvelope<T>, status = 200): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function getMeResponse(username = 'systemvitals_test_bot'): Response {
  return response<TelegramUser>({
    ok: true,
    result: { id: 123456, is_bot: true, username },
  });
}

function makeClient(
  env: Partial<Record<keyof typeof TELEGRAM_CONFIG, string>> = TELEGRAM_CONFIG,
) {
  const configService = {
    get: jest.fn((key: string) => env[key as keyof typeof TELEGRAM_CONFIG]),
  } as unknown as ConfigService;
  const fetch = jest.fn<ReturnType<TelegramFetch>, Parameters<TelegramFetch>>();

  return {
    client: new TelegramBotClient(configService, fetch),
    fetch,
  };
}

function requestBody(
  fetch: jest.MockedFunction<TelegramFetch>,
  callIndex: number,
): unknown {
  const [, init] = fetch.mock.calls[callIndex];
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ 'content-type': 'application/json' });
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(typeof init.body).toBe('string');
  if (typeof init.body !== 'string') {
    throw new Error('Expected a JSON string request body');
  }
  return JSON.parse(init.body) as unknown;
}

function expectSanitized(message: string, method: string): void {
  expect(message).toBe(`Telegram ${method} failed`);
  expect(message).not.toContain(TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN);
  expect(message).not.toContain(BOT_API_ROOT);
}

async function captureError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected operation to reject');
}

describe('TelegramBotClient', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stays unavailable without a token and makes no request', async () => {
    const { client, fetch } = makeClient({});

    await client.onModuleInit();

    await expect(client.getPublicBot()).resolves.toEqual({
      available: false,
      id: null,
      username: null,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('initializes with getMe followed by the constrained webhook body', async () => {
    const { client, fetch } = makeClient();
    fetch
      .mockResolvedValueOnce(getMeResponse())
      .mockResolvedValueOnce(response({ ok: true, result: true }));

    await client.onModuleInit();

    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(
      calls.map(([input]) => new URL(input).pathname.split('/').at(-1)),
    ).toEqual(['getMe', 'setWebhook']);
    expect(requestBody(fetch, 0)).toEqual({});
    expect(requestBody(fetch, 1)).toEqual({
      url: TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_URL,
      allowed_updates: ['message', 'channel_post'],
      secret_token: TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_SECRET,
    });
    expect(JSON.stringify(requestBody(fetch, 1))).not.toContain(
      TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN,
    );
  });

  it('publishes the string bot id and username returned by getMe', async () => {
    const { client, fetch } = makeClient();
    fetch
      .mockResolvedValueOnce(getMeResponse('managed_test_bot'))
      .mockResolvedValueOnce(response({ ok: true, result: true }));

    await client.onModuleInit();

    await expect(client.getPublicBot()).resolves.toEqual({
      available: true,
      id: '123456',
      username: 'managed_test_bot',
    });
  });

  it('trims the validated getMe username before publishing it', async () => {
    const { client, fetch } = makeClient();
    fetch
      .mockResolvedValueOnce(getMeResponse('  managed_test_bot  '))
      .mockResolvedValueOnce(response({ ok: true, result: true }));

    await client.onModuleInit();

    await expect(client.getPublicBot()).resolves.toMatchObject({
      available: true,
      username: 'managed_test_bot',
    });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['wrong-type', 'not-a-bot-object'],
  ])('sanitizes a getMe envelope with a %s result', async (_name, result) => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { client, fetch } = makeClient();
    fetch
      .mockResolvedValueOnce(response<unknown>({ ok: true, result }))
      .mockResolvedValueOnce(response({ ok: true, result: true }));

    await client.onModuleInit();

    expect(logger).toHaveBeenCalledTimes(1);
    expectSanitized(String(logger.mock.calls[0][0]), 'getMe');
    await expect(client.getPublicBot()).resolves.toEqual({
      available: false,
      id: null,
      username: null,
    });
  });

  it.each([
    [
      'is_bot false',
      { id: 123456, is_bot: false, username: 'managed_test_bot' },
    ],
    [
      'an unsafe id',
      {
        id: Number.MAX_SAFE_INTEGER + 1,
        is_bot: true,
        username: 'managed_test_bot',
      },
    ],
    ['a missing username', { id: 123456, is_bot: true }],
    ['a blank username', { id: 123456, is_bot: true, username: '   ' }],
    ['a non-string username', { id: 123456, is_bot: true, username: 123 }],
  ])('sanitizes getMe identity with %s', async (_name, result) => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { client, fetch } = makeClient();
    fetch
      .mockResolvedValueOnce(response<unknown>({ ok: true, result }))
      .mockResolvedValueOnce(response({ ok: true, result: true }));

    await client.onModuleInit();

    expect(logger).toHaveBeenCalledTimes(1);
    expectSanitized(String(logger.mock.calls[0][0]), 'getMe');
    await expect(client.getPublicBot()).resolves.toEqual({
      available: false,
      id: null,
      username: null,
    });
  });

  it('sanitizes a false setWebhook result', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { client, fetch } = makeClient();
    fetch
      .mockResolvedValueOnce(getMeResponse())
      .mockResolvedValueOnce(response({ ok: true, result: false }));

    await client.onModuleInit();

    expect(logger).toHaveBeenCalledTimes(1);
    expectSanitized(String(logger.mock.calls[0][0]), 'setWebhook');
    await expect(client.getPublicBot()).resolves.toEqual({
      available: false,
      id: null,
      username: null,
    });
  });

  it('preserves exact sendMessage fields including a supplied thread id', async () => {
    const { client, fetch } = makeClient();
    fetch.mockResolvedValueOnce(
      response({ ok: true, result: { message_id: 987 } }),
    );

    await expect(
      client.sendMessage({
        chatId: '-1001234567890',
        text: 'Synthetic alert text',
        messageThreadId: 42,
      }),
    ).resolves.toEqual({ message_id: 987 });
    expect(requestBody(fetch, 0)).toEqual({
      chat_id: '-1001234567890',
      text: 'Synthetic alert text',
      message_thread_id: 42,
    });
  });

  it.each([
    ['missing', {}],
    ['null', { message_id: null }],
    ['wrong-type', { message_id: '987' }],
    ['unsafe', { message_id: Number.MAX_SAFE_INTEGER + 1 }],
  ])('sanitizes sendMessage with a %s message_id', async (_name, result) => {
    const { client, fetch } = makeClient();
    fetch.mockResolvedValueOnce(response<unknown>({ ok: true, result }));

    const error = await captureError(
      client.sendMessage({
        chatId: '-1001234567890',
        text: 'Synthetic alert text',
      }),
    );

    expectSanitized(error.message, 'sendMessage');
  });

  it('sanitizes malformed Bot API JSON', async () => {
    const { client, fetch } = makeClient();
    fetch.mockResolvedValueOnce(
      new Response('{malformed-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const error = await captureError(
      client.sendMessage({
        chatId: '-1001234567890',
        text: 'Synthetic alert text',
      }),
    );

    expectSanitized(error.message, 'sendMessage');
  });

  it('omits message_thread_id when sendMessage receives no thread id', async () => {
    const { client, fetch } = makeClient();
    fetch.mockResolvedValueOnce(
      response({ ok: true, result: { message_id: 654 } }),
    );

    await client.sendMessage({
      chatId: '@synthetic_channel',
      text: 'Synthetic alert text',
    });

    expect(requestBody(fetch, 0)).toEqual({
      chat_id: '@synthetic_channel',
      text: 'Synthetic alert text',
    });
  });

  it.each(['http', 'envelope'] as const)(
    'sanitizes a getMe %s failure',
    async (failureKind) => {
      const logger = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { client, fetch } = makeClient();
      fetch.mockResolvedValueOnce(
        failureKind === 'http'
          ? response(
              {
                ok: false,
                description: `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/getMe`,
              },
              502,
            )
          : response({
              ok: false,
              description: `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/getMe`,
            }),
      );

      await client.onModuleInit();

      expect(logger).toHaveBeenCalledTimes(1);
      expectSanitized(String(logger.mock.calls[0][0]), 'getMe');
      await expect(client.getPublicBot()).resolves.toEqual({
        available: false,
        id: null,
        username: null,
      });
    },
  );

  it.each(['http', 'envelope'] as const)(
    'sanitizes a setWebhook %s failure',
    async (failureKind) => {
      const logger = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { client, fetch } = makeClient();
      fetch.mockResolvedValueOnce(getMeResponse()).mockResolvedValueOnce(
        failureKind === 'http'
          ? response(
              {
                ok: false,
                description: `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/setWebhook`,
              },
              500,
            )
          : response({
              ok: false,
              description: `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/setWebhook`,
            }),
      );

      await client.onModuleInit();

      expect(logger).toHaveBeenCalledTimes(1);
      expectSanitized(String(logger.mock.calls[0][0]), 'setWebhook');
      await expect(client.getPublicBot()).resolves.toEqual({
        available: false,
        id: null,
        username: null,
      });
    },
  );

  it.each(['http', 'envelope'] as const)(
    'sanitizes a sendMessage %s failure',
    async (failureKind) => {
      const { client, fetch } = makeClient();
      fetch.mockResolvedValueOnce(
        failureKind === 'http'
          ? response(
              {
                ok: false,
                description: `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/sendMessage`,
              },
              429,
            )
          : response({
              ok: false,
              description: `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/sendMessage`,
            }),
      );

      const error = await captureError(
        client.sendMessage({
          chatId: '-1001234567890',
          text: 'Synthetic alert text',
        }),
      );

      expectSanitized(error.message, 'sendMessage');
    },
  );

  it('sanitizes a thrown fetch error', async () => {
    const { client, fetch } = makeClient();
    fetch.mockRejectedValueOnce(
      new Error(
        `${TELEGRAM_CONFIG.TELEGRAM_BOT_TOKEN} ${BOT_API_ROOT}/sendMessage`,
      ),
    );

    const error = await captureError(
      client.sendMessage({
        chatId: '-1001234567890',
        text: 'Synthetic alert text',
      }),
    );

    expectSanitized(error.message, 'sendMessage');
  });

  it('retries failed initialization only at the 60-second boundary', async () => {
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const { client, fetch } = makeClient();
    fetch
      .mockRejectedValueOnce(new Error('synthetic network failure'))
      .mockResolvedValueOnce(getMeResponse())
      .mockResolvedValueOnce(response({ ok: true, result: true }));

    await client.onModuleInit();
    await expect(client.getPublicBot()).resolves.toMatchObject({
      available: false,
    });
    now.mockReturnValue(1_059_999);
    await expect(client.getPublicBot()).resolves.toMatchObject({
      available: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);

    now.mockReturnValue(1_060_000);
    await expect(client.getPublicBot()).resolves.toMatchObject({
      available: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(logger).toHaveBeenCalledTimes(1);
  });

  it('shares one configured refresh across concurrent callers', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const now = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    const { client, fetch } = makeClient();
    let resolveGetMe: ((value: Response) => void) | undefined;
    fetch
      .mockRejectedValueOnce(new Error('synthetic network failure'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveGetMe = resolve;
          }),
      )
      .mockResolvedValueOnce(response({ ok: true, result: true }));
    await client.onModuleInit();
    now.mockReturnValue(2_060_000);

    const first = client.getPublicBot();
    const second = client.getPublicBot();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resolveGetMe).toBeDefined();
    resolveGetMe?.(getMeResponse());
    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        available: true,
        id: '123456',
        username: 'systemvitals_test_bot',
      },
      {
        available: true,
        id: '123456',
        username: 'systemvitals_test_bot',
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('accepts only the exact configured webhook secret', () => {
    const { client } = makeClient();

    expect(() =>
      client.assertWebhookSecret(TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_SECRET),
    ).not.toThrow();
  });

  it.each([undefined, 'wrong_webhook_secret'])(
    'rejects the webhook secret candidate %s',
    (candidate) => {
      const { client } = makeClient();

      expect(() => client.assertWebhookSecret(candidate)).toThrow(
        new UnauthorizedException('Invalid Telegram webhook'),
      );
    },
  );

  it('rejects webhook secret assertions when Telegram is unconfigured', () => {
    const { client } = makeClient({});

    expect(() =>
      client.assertWebhookSecret(TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_SECRET),
    ).toThrow(new UnauthorizedException('Invalid Telegram webhook'));
  });

  it.each(INCOMPLETE_TELEGRAM_CONFIGS)(
    'keeps initialization unavailable with zero requests for %s',
    async (_name, env) => {
      const { client, fetch } = makeClient(env);
      fetch
        .mockResolvedValueOnce(getMeResponse())
        .mockResolvedValueOnce(response({ ok: true, result: true }));

      await client.onModuleInit();

      await expect(client.getPublicBot()).resolves.toEqual({
        available: false,
        id: null,
        username: null,
      });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(INCOMPLETE_TELEGRAM_CONFIGS)(
    'rejects sendMessage without a request for %s',
    async (_name, env) => {
      const { client, fetch } = makeClient(env);
      fetch.mockResolvedValueOnce(
        response({ ok: true, result: { message_id: 987 } }),
      );

      const error = await captureError(
        client.sendMessage({
          chatId: '-1001234567890',
          text: 'Synthetic alert text',
        }),
      );

      expectSanitized(error.message, 'sendMessage');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(INCOMPLETE_TELEGRAM_CONFIGS)(
    'rejects webhook secret assertions for %s',
    (_name, env) => {
      const { client } = makeClient(env);

      expect(() =>
        client.assertWebhookSecret(TELEGRAM_CONFIG.TELEGRAM_WEBHOOK_SECRET),
      ).toThrow(new UnauthorizedException('Invalid Telegram webhook'));
    },
  );
});
