import type { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import type { PrismaService } from '../prisma/prisma.service';
import type { TelegramBotClient } from './telegram-bot.client';
import {
  TELEGRAM_CHALLENGES_PER_MINUTE,
  TELEGRAM_CHALLENGE_TTL_MS,
  TELEGRAM_PENDING_DELIVERY_LEASE_MS,
  TelegramConnectionsService,
} from './telegram-connections.service';
import type { TelegramStartUpdate } from './telegram-update';

const NOW = new Date('2032-03-04T05:06:07.000Z');
const APP_URL = 'https://app.example.test';
const REPLY_PREFIX =
  'Connect this destination to SystemVitals (expires in 10 minutes):\n';
const DEFAULT_APP_URL = Symbol('DEFAULT_APP_URL');
const MISSING_APP_URL = Symbol('MISSING_APP_URL');

const TOPIC_UPDATE: TelegramStartUpdate = {
  updateId: 'synthetic-update-101',
  chatId: '-1001234567890',
  chatType: 'supergroup',
  chatTitle: 'Synthetic Operations',
  messageThreadId: 42,
};

interface ChallengeMocks {
  count: jest.Mock;
  create: jest.Mock;
  delete: jest.Mock;
  deleteMany: jest.Mock;
  findUnique: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
}

interface MockCallHistory {
  mock: {
    calls: unknown[][];
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function makeService(
  configuredAppUrl:
    | string
    | typeof DEFAULT_APP_URL
    | typeof MISSING_APP_URL = DEFAULT_APP_URL,
  nodeEnv = 'test',
) {
  const appUrl =
    configuredAppUrl === DEFAULT_APP_URL
      ? `${APP_URL}/`
      : configuredAppUrl === MISSING_APP_URL
        ? undefined
        : configuredAppUrl;
  const challenges: ChallengeMocks = {
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn().mockResolvedValue({ id: 'new-challenge-id' }),
    delete: jest.fn().mockResolvedValue({ id: 'new-challenge-id' }),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'challenge-id' }),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const queryRaw = jest.fn().mockResolvedValue([{ locked: null }]);
  const projects = {
    findUnique: jest.fn().mockResolvedValue({
      id: 'project-1',
      organizationId: 'organization-1',
    }),
  };
  const memberships = {
    findUnique: jest.fn().mockResolvedValue({
      userId: 'user-1',
      organizationId: 'organization-1',
    }),
  };
  const notificationChannels = {
    create: jest.fn().mockResolvedValue({
      id: 'channel-1',
      projectId: 'project-1',
      type: 'TELEGRAM',
      destinationKey: 'chat:-1001234567890:topic:42',
      config: {
        mode: 'MANAGED',
        chatId: '-1001234567890',
        chatType: 'supergroup',
        chatTitle: 'Synthetic Operations',
        messageThreadId: 42,
      },
      enabled: true,
    }),
  };
  const transactionClient = {
    telegramConnectionChallenge: challenges,
    project: projects,
    membership: memberships,
    notificationChannel: notificationChannels,
    $queryRaw: queryRaw,
  };
  const transaction = jest.fn(
    async (callback: (client: typeof transactionClient) => Promise<unknown>) =>
      callback(transactionClient),
  );
  const prisma = {
    telegramConnectionChallenge: challenges,
    $transaction: transaction,
  } as unknown as PrismaService;
  const sendMessage = jest
    .fn()
    .mockResolvedValue({ message_id: 123456 }) as jest.MockedFunction<
    TelegramBotClient['sendMessage']
  >;
  const telegramBot = { sendMessage } as unknown as TelegramBotClient;
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'APP_URL') return appUrl;
      if (key === 'NODE_ENV') return nodeEnv;
      return undefined;
    }),
  } as unknown as ConfigService;

  return {
    service: new TelegramConnectionsService(prisma, telegramBot, config),
    challenges,
    memberships,
    notificationChannels,
    projects,
    queryRaw,
    sendMessage,
    transaction,
    transactionClient,
  };
}

interface PreviewService {
  preview(rawToken: string): Promise<unknown>;
}

interface ConnectService {
  connect(
    userId: string,
    rawToken: string,
    projectId: string,
  ): Promise<unknown>;
}

function preview(
  service: TelegramConnectionsService,
  rawToken: string,
): Promise<unknown> {
  return Promise.resolve().then(() =>
    (service as unknown as PreviewService).preview(rawToken),
  );
}

function connect(
  service: TelegramConnectionsService,
  userId: string,
  rawToken: string,
  projectId: string,
): Promise<unknown> {
  return Promise.resolve().then(() =>
    (service as unknown as ConnectService).connect(userId, rawToken, projectId),
  );
}

const RAW_TOKEN = 'unit-raw-token-that-must-never-reach-prisma';
const TOKEN_HASH = createHash('sha256').update(RAW_TOKEN).digest('hex');

function challenge(
  overrides: Partial<{
    id: string;
    tokenHash: string;
    telegramUpdateId: string;
    chatId: string;
    chatType: string;
    chatTitle: string | null;
    messageThreadId: number | null;
    expiresAt: Date;
    deliveredAt: Date | null;
    consumedAt: Date | null;
    createdAt: Date;
  }> = {},
) {
  return {
    id: 'challenge-id',
    tokenHash: TOKEN_HASH,
    telegramUpdateId: 'telegram-update-id',
    chatId: '-1001234567890',
    chatType: 'supergroup',
    chatTitle: 'Synthetic Operations',
    messageThreadId: 42,
    expiresAt: new Date(NOW.getTime() + 60_000),
    deliveredAt: new Date(NOW.getTime() - 1_000),
    consumedAt: null,
    createdAt: new Date(NOW.getTime() - 2_000),
    ...overrides,
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected an object value');
  }
  return value as Record<string, unknown>;
}

function firstCallArgument(mock: MockCallHistory): Record<string, unknown> {
  const value: unknown = mock.mock.calls[0]?.[0];
  return objectValue(value);
}

function callArgument(
  mock: MockCallHistory,
  callIndex: number,
  argumentIndex: number,
): unknown {
  return mock.mock.calls[callIndex]?.[argumentIndex];
}

function sentText(sendMessage: MockCallHistory): string {
  const argument = firstCallArgument(sendMessage);
  if (typeof argument.text !== 'string') {
    throw new Error('Expected a string reply');
  }
  return argument.text;
}

function tokenFromReply(
  sendMessage: MockCallHistory,
  appUrl = APP_URL,
): string {
  const expectedUrlPrefix = `${REPLY_PREFIX}${appUrl}/channels/telegram/connect?token=`;
  const text = sentText(sendMessage);
  expect(text.startsWith(expectedUrlPrefix)).toBe(true);
  return text.slice(expectedUrlPrefix.length);
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

function captureConstructionError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('Expected construction to throw');
}

describe('TelegramConnectionsService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('uses a 30-second pending delivery lease', () => {
    expect(TELEGRAM_PENDING_DELIVERY_LEASE_MS).toBe(30_000);
  });

  it('generates a 32-byte base64url bearer token and stores only its SHA-256 hash', async () => {
    const { service, challenges, sendMessage } = makeService();

    await service.handleStart(TOPIC_UPDATE);

    const rawToken = tokenFromReply(sendMessage);
    expect(rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(rawToken, 'base64url')).toHaveLength(32);

    const createArgument = firstCallArgument(challenges.create);
    const data = objectValue(createArgument.data);
    expect(data.tokenHash).toBe(
      createHash('sha256').update(rawToken).digest('hex'),
    );
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(createArgument)).not.toContain(rawToken);
    expect(
      JSON.stringify({
        count: challenges.count.mock.calls,
        create: challenges.create.mock.calls,
        delete: challenges.delete.mock.calls,
        deleteMany: challenges.deleteMany.mock.calls,
        findUnique: challenges.findUnique.mock.calls,
        updateMany: challenges.updateMany.mock.calls,
      }),
    ).not.toContain(rawToken);
    expect(sentText(sendMessage)).toBe(
      `${REPLY_PREFIX}${APP_URL}/channels/telegram/connect?token=${rawToken}`,
    );
  });

  it('persists update, destination, topic, and ten-minute expiry metadata', async () => {
    const { service, challenges } = makeService();

    await service.handleStart(TOPIC_UPDATE);

    const data = objectValue(firstCallArgument(challenges.create).data);
    expect(typeof data.tokenHash).toBe('string');
    expect(data.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(data).toEqual({
      tokenHash: data.tokenHash,
      telegramUpdateId: TOPIC_UPDATE.updateId,
      chatId: TOPIC_UPDATE.chatId,
      chatType: TOPIC_UPDATE.chatType,
      chatTitle: TOPIC_UPDATE.chatTitle,
      messageThreadId: TOPIC_UPDATE.messageThreadId,
      expiresAt: new Date(NOW.getTime() + TELEGRAM_CHALLENGE_TTL_MS),
      deliveredAt: null,
    });
  });

  it('claims under a parameterized destination advisory lock in a short transaction committed before reply', async () => {
    const { service, queryRaw, sendMessage, transaction, transactionClient } =
      makeService();
    let transactionCommitted = false;
    transaction.mockImplementation(
      async (
        callback: (client: typeof transactionClient) => Promise<unknown>,
      ) => {
        const result = await callback(transactionClient);
        transactionCommitted = true;
        return result;
      },
    );
    sendMessage.mockImplementation(() => {
      expect(transactionCommitted).toBe(true);
      return Promise.resolve({ message_id: 123456 });
    });

    await service.handleStart(TOPIC_UPDATE);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(callArgument(transaction, 0, 1)).toEqual({ timeout: 5_000 });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sqlParts = callArgument(queryRaw, 0, 0);
    expect(Array.isArray(sqlParts)).toBe(true);
    const sql = (sqlParts as unknown[]).join('?');
    expect(sql).toMatch(
      /pg_advisory_xact_lock\(\s*hashtextextended\(\?, 0\)\s*\)::text/,
    );
    expect(sql).not.toContain(TOPIC_UPDATE.chatId);
    expect(callArgument(queryRaw, 0, 1)).toBe(
      `telegram-challenge:${TOPIC_UPDATE.chatId}:topic:${TOPIC_UPDATE.messageThreadId}`,
    );
  });

  it('marks only the exact pending challenge delivered after reply succeeds', async () => {
    const { service, challenges, sendMessage } = makeService();

    await service.handleStart(TOPIC_UPDATE);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(challenges.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'new-challenge-id',
        deliveredAt: null,
      },
      data: { deliveredAt: NOW },
    });
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      challenges.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('normalizes a valid trailing APP_URL slash and replies to the exact chat topic', async () => {
    const { service, sendMessage } = makeService(`${APP_URL}/`);

    await service.handleStart(TOPIC_UPDATE);

    const rawToken = tokenFromReply(sendMessage);
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: TOPIC_UPDATE.chatId,
      messageThreadId: TOPIC_UPDATE.messageThreadId,
      text: `${REPLY_PREFIX}${APP_URL}/channels/telegram/connect?token=${rawToken}`,
    });
    expect(sentText(sendMessage)).not.toContain(`${APP_URL}//channels`);
  });

  it('requires APP_URL in production without leaking configuration', () => {
    const error = captureConstructionError(() =>
      makeService(MISSING_APP_URL, 'production'),
    );

    expect(error.message).toBe('APP_URL configuration is invalid');
  });

  it.each([
    ['malformed', 'not a URL', 'test'],
    ['unsupported protocol', 'ftp://app.example.test', 'test'],
    ['credentials', 'https://user:pass@app.example.test', 'production'],
    ['non-root pathname', 'https://app.example.test/base', 'production'],
    ['query', 'https://app.example.test/?mode=test', 'production'],
    ['fragment', 'https://app.example.test/#section', 'production'],
    ['insecure production protocol', 'http://app.example.test', 'production'],
  ])(
    'rejects a %s APP_URL with a sanitized error',
    (_caseName, configuredAppUrl, nodeEnv) => {
      const error = captureConstructionError(() =>
        makeService(configuredAppUrl, nodeEnv),
      );

      expect(error.message).toBe('APP_URL configuration is invalid');
      expect(error.message).not.toContain(configuredAppUrl);
    },
  );

  it.each(['test', 'development'])(
    'uses the local APP_URL fallback in %s',
    async (nodeEnv) => {
      const { service, sendMessage } = makeService(MISSING_APP_URL, nodeEnv);

      await service.handleStart(TOPIC_UPDATE);

      const fallbackUrl = 'http://localhost:9999';
      const rawToken = tokenFromReply(sendMessage, fallbackUrl);
      expect(sentText(sendMessage)).toBe(
        `${REPLY_PREFIX}${fallbackUrl}/channels/telegram/connect?token=${rawToken}`,
      );
    },
  );

  it('scopes the recent challenge count to the exact topic destination', async () => {
    const { service, challenges } = makeService();

    await service.handleStart(TOPIC_UPDATE);

    expect(challenges.count).toHaveBeenCalledWith({
      where: {
        chatId: TOPIC_UPDATE.chatId,
        messageThreadId: TOPIC_UPDATE.messageThreadId,
        createdAt: { gte: new Date(NOW.getTime() - 60_000) },
      },
    });
  });

  it('uses explicit null to scope a destination without a topic', async () => {
    const { service, challenges, queryRaw } = makeService();
    const update: TelegramStartUpdate = {
      ...TOPIC_UPDATE,
      updateId: 'synthetic-update-no-topic',
      messageThreadId: undefined,
    };

    await service.handleStart(update);

    expect(challenges.count).toHaveBeenCalledWith({
      where: {
        chatId: update.chatId,
        messageThreadId: null,
        createdAt: { gte: new Date(NOW.getTime() - 60_000) },
      },
    });
    expect(firstCallArgument(challenges.create)).toMatchObject({
      data: { messageThreadId: null },
    });
    expect(callArgument(queryRaw, 0, 1)).toBe(
      `telegram-challenge:${update.chatId}:root`,
    );
  });

  it('acknowledges an already delivered duplicate without reply', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.findUnique.mockResolvedValue({
      id: 'delivered-challenge-id',
      deliveredAt: new Date(NOW.getTime() - 1_000),
      createdAt: new Date(NOW.getTime() - 2_000),
    });

    await expect(service.handleStart(TOPIC_UPDATE)).resolves.toBeUndefined();

    expect(challenges.delete).not.toHaveBeenCalled();
    expect(challenges.count).not.toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(challenges.updateMany).not.toHaveBeenCalled();
  });

  it('treats a pending duplicate one millisecond inside the lease as active', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.findUnique.mockResolvedValue({
      id: 'active-pending-challenge-id',
      deliveredAt: null,
      createdAt: new Date(
        NOW.getTime() - TELEGRAM_PENDING_DELIVERY_LEASE_MS + 1,
      ),
    });

    await expect(service.handleStart(TOPIC_UPDATE)).rejects.toThrow(
      'Telegram challenge delivery in progress',
    );

    expect(challenges.delete).not.toHaveBeenCalled();
    expect(challenges.count).not.toHaveBeenCalled();
    expect(challenges.create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(challenges.updateMany).not.toHaveBeenCalled();
  });

  it('replaces a pending duplicate at the exact lease cutoff before counting and replying', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.findUnique.mockResolvedValue({
      id: 'stale-pending-challenge-id',
      deliveredAt: null,
      createdAt: new Date(NOW.getTime() - TELEGRAM_PENDING_DELIVERY_LEASE_MS),
    });

    await service.handleStart(TOPIC_UPDATE);

    expect(challenges.delete).toHaveBeenCalledWith({
      where: { id: 'stale-pending-challenge-id' },
    });
    expect(challenges.delete.mock.invocationCallOrder[0]).toBeLessThan(
      challenges.count.mock.invocationCallOrder[0],
    );
    expect(challenges.create).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects an overlapping duplicate while the first send is pending, then marks the first delivered', async () => {
    const { service, challenges, sendMessage } = makeService();
    const firstSendStarted = deferred<void>();
    const releaseFirstSend = deferred<{ message_id: number }>();
    challenges.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'new-challenge-id',
      deliveredAt: null,
      createdAt: NOW,
    });
    sendMessage.mockImplementationOnce(() => {
      firstSendStarted.resolve(undefined);
      return releaseFirstSend.promise;
    });

    const firstHandling = service.handleStart(TOPIC_UPDATE);
    await firstSendStarted.promise;

    const secondError = await captureError(service.handleStart(TOPIC_UPDATE));
    expect(secondError.message).toBe('Telegram challenge delivery in progress');
    expect(secondError.message).not.toContain(APP_URL);
    expect(challenges.delete).not.toHaveBeenCalled();
    expect(challenges.count).toHaveBeenCalledTimes(1);
    expect(challenges.create).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);

    releaseFirstSend.resolve({ message_id: 123456 });
    await expect(firstHandling).resolves.toBeUndefined();
    expect(challenges.updateMany).toHaveBeenCalledTimes(1);
    expect(challenges.updateMany).toHaveBeenCalledWith({
      where: { id: 'new-challenge-id', deliveredAt: null },
      data: { deliveredAt: NOW },
    });
  });

  it('counts after removing a pending retry and throttles when six rows remain', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.findUnique.mockResolvedValue({
      id: 'stale-pending-challenge-id',
      deliveredAt: null,
      createdAt: new Date(
        NOW.getTime() - TELEGRAM_PENDING_DELIVERY_LEASE_MS - 1,
      ),
    });
    challenges.count.mockResolvedValue(TELEGRAM_CHALLENGES_PER_MINUTE);

    await expect(service.handleStart(TOPIC_UPDATE)).resolves.toBeUndefined();

    expect(challenges.delete).toHaveBeenCalledWith({
      where: { id: 'stale-pending-challenge-id' },
    });
    expect(challenges.delete.mock.invocationCallOrder[0]).toBeLessThan(
      challenges.count.mock.invocationCallOrder[0],
    );
    expect(challenges.create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2, 3, 4, 5])(
    'creates and replies when the exact-destination count is %i',
    async (recentCount) => {
      const { service, challenges, sendMessage } = makeService();
      challenges.count.mockResolvedValue(recentCount);

      await expect(service.handleStart(TOPIC_UPDATE)).resolves.toBeUndefined();

      expect(challenges.create).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('acknowledges without create or reply when the exact-destination count is six', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.count.mockResolvedValue(TELEGRAM_CHALLENGES_PER_MINUTE);

    await expect(service.handleStart(TOPIC_UPDATE)).resolves.toBeUndefined();

    expect(challenges.count).toHaveBeenCalledTimes(1);
    expect(challenges.create).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['Prisma field target', ['telegramUpdateId']],
    [
      'physical unique-index target',
      'telegram_connection_challenges_telegram_update_id_key',
    ],
  ])(
    'acknowledges duplicate-update P2002 for the %s without reply or rollback deletion',
    async (_case, target) => {
      const { service, challenges, sendMessage, transaction } = makeService();
      challenges.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: 'concurrently-delivered-challenge-id',
        deliveredAt: NOW,
        createdAt: new Date(NOW.getTime() - 1_000),
      });
      challenges.create.mockRejectedValueOnce({
        code: 'P2002',
        meta: { target },
      });

      await expect(service.handleStart(TOPIC_UPDATE)).resolves.toBeUndefined();

      expect(challenges.create).toHaveBeenCalledTimes(1);
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(challenges.findUnique).toHaveBeenCalledTimes(2);
      expect(sendMessage).not.toHaveBeenCalled();
      expect(challenges.delete).not.toHaveBeenCalled();
    },
  );

  it('does not swallow an unrelated create error', async () => {
    const { service, challenges, sendMessage } = makeService();
    const databaseFailure = new Error('synthetic database failure');
    challenges.create.mockRejectedValue(databaseFailure);

    await expect(service.handleStart(TOPIC_UPDATE)).rejects.toBe(
      databaseFailure,
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(challenges.delete).not.toHaveBeenCalled();
  });

  it('does not swallow a P2002 for a different unique field', async () => {
    const { service, challenges, sendMessage } = makeService();
    const tokenHashCollision = {
      code: 'P2002',
      meta: { target: ['token_hash'] },
    };
    challenges.create.mockRejectedValue(tokenHashCollision);

    await expect(service.handleStart(TOPIC_UPDATE)).rejects.toBe(
      tokenHashCollision,
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(challenges.delete).not.toHaveBeenCalled();
  });

  it.each([
    ['misleading target name', 'archived_telegram_update_id_copy'],
    ['mixed target array', ['telegramUpdateId', 'tokenHash']],
  ])('does not swallow a P2002 with a %s', async (_case, target) => {
    const { service, challenges, sendMessage } = makeService();
    const unrelatedCollision = {
      code: 'P2002',
      meta: { target },
    };
    challenges.create.mockRejectedValue(unrelatedCollision);

    await expect(service.handleStart(TOPIC_UPDATE)).rejects.toBe(
      unrelatedCollision,
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(challenges.delete).not.toHaveBeenCalled();
  });

  it('deletes only the new challenge after send failure and throws a sanitized error', async () => {
    const configuredAppUrl = `${APP_URL}/`;
    const { service, challenges, sendMessage } = makeService(configuredAppUrl);
    sendMessage.mockRejectedValue(
      new Error(
        `synthetic Telegram description and body mentioning ${configuredAppUrl}`,
      ),
    );

    const error = await captureError(service.handleStart(TOPIC_UPDATE));
    const rawToken = tokenFromReply(sendMessage);

    expect(challenges.delete).toHaveBeenCalledWith({
      where: { id: 'new-challenge-id' },
    });
    expect(challenges.delete).toHaveBeenCalledTimes(1);
    expect(challenges.updateMany).not.toHaveBeenCalled();
    expect(error.message).toBe('Telegram challenge reply failed');
    expect(error.message).not.toContain(rawToken);
    expect(error.message).not.toContain(APP_URL);
    expect(error.message).not.toContain('description');
    expect(error.message).not.toContain('body');
    expect(error.message).not.toContain(configuredAppUrl);
  });

  it('keeps the transport error sanitized even when rollback deletion fails', async () => {
    const { service, challenges, sendMessage } = makeService();
    sendMessage.mockRejectedValue(new Error('synthetic transport details'));
    challenges.delete.mockRejectedValue(
      new Error('synthetic rollback details'),
    );

    await expect(service.handleStart(TOPIC_UPDATE)).rejects.toThrow(
      'Telegram challenge reply failed',
    );
  });

  it('keeps a pending row and throws sanitized when delivery marking rejects', async () => {
    const configuredAppUrl = `${APP_URL}/`;
    const { service, challenges, sendMessage } = makeService(configuredAppUrl);
    challenges.updateMany.mockRejectedValue(
      new Error(
        `synthetic delivery database body mentioning ${configuredAppUrl}`,
      ),
    );

    const error = await captureError(service.handleStart(TOPIC_UPDATE));
    const rawToken = tokenFromReply(sendMessage);

    expect(challenges.delete).not.toHaveBeenCalled();
    expect(error.message).toBe(
      'Telegram challenge delivery confirmation failed',
    );
    expect(error.message).not.toContain(rawToken);
    expect(error.message).not.toContain(APP_URL);
    expect(error.message).not.toContain('database');
    expect(error.message).not.toContain('body');
  });

  it('treats a missing pending row during delivery marking as sanitized failure', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.updateMany.mockResolvedValue({ count: 0 });

    const error = await captureError(service.handleStart(TOPIC_UPDATE));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(challenges.delete).not.toHaveBeenCalled();
    expect(error.message).toBe(
      'Telegram challenge delivery confirmation failed',
    );
  });

  it('cleans up only challenges expired more than 24 hours ago', async () => {
    const { service, challenges } = makeService();

    await service.handleStart(TOPIC_UPDATE);

    expect(challenges.deleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) },
      },
    });
    const cleanupArgument = JSON.stringify(
      firstCallArgument(challenges.deleteMany),
    );
    expect(cleanupArgument).not.toContain('gte');
  });

  it('issues and replies without waiting for pending old-challenge cleanup', async () => {
    const { service, challenges, sendMessage } = makeService();
    const pendingCleanup = deferred<{ count: number }>();
    challenges.deleteMany.mockReturnValue(pendingCleanup.promise);

    const handling = service.handleStart(TOPIC_UPDATE);
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
    }

    expect(challenges.count).toHaveBeenCalledTimes(1);
    expect(challenges.create).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await expect(handling).resolves.toBeUndefined();

    pendingCleanup.resolve({ count: 0 });
    await Promise.resolve();
  });

  it('shares one pending cleanup across concurrent starts while both issue', async () => {
    const { service, challenges, sendMessage } = makeService();
    const pendingCleanup = deferred<{ count: number }>();
    challenges.deleteMany.mockReturnValue(pendingCleanup.promise);
    const secondUpdate: TelegramStartUpdate = {
      ...TOPIC_UPDATE,
      updateId: 'synthetic-update-102',
    };

    const handling = Promise.all([
      service.handleStart(TOPIC_UPDATE),
      service.handleStart(secondUpdate),
    ]);
    for (let turn = 0; turn < 12; turn += 1) {
      await Promise.resolve();
    }

    expect(challenges.deleteMany).toHaveBeenCalledTimes(1);
    expect(challenges.count).toHaveBeenCalledTimes(2);
    expect(challenges.create).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    await expect(handling).resolves.toEqual([undefined, undefined]);

    pendingCleanup.resolve({ count: 0 });
    await Promise.resolve();
  });

  it('does not fail a successful handshake when old-challenge cleanup fails', async () => {
    const { service, challenges, sendMessage } = makeService();
    challenges.deleteMany.mockRejectedValue(
      new Error('synthetic cleanup failure'),
    );

    await expect(service.handleStart(TOPIC_UPDATE)).resolves.toBeUndefined();

    expect(challenges.create).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  describe('preview', () => {
    it('queries only by the SHA-256 token hash and never passes the raw token to Prisma', async () => {
      const { service, challenges } = makeService();
      challenges.findUnique.mockResolvedValue(challenge());

      await preview(service, RAW_TOKEN);

      expect(challenges.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: TOKEN_HASH },
      });
      expect(JSON.stringify(challenges.findUnique.mock.calls)).not.toContain(
        RAW_TOKEN,
      );
    });

    it('rejects a missing challenge with the stable invalid-link message', async () => {
      const { service, challenges } = makeService();
      challenges.findUnique.mockResolvedValue(null);

      const error = await captureError(preview(service, RAW_TOKEN));

      expect(error.message).toBe('This Telegram connection link is invalid');
      expect(error.message).not.toContain(RAW_TOKEN);
    });

    it('requires delivery before checking whether the challenge was consumed', async () => {
      const { service, challenges } = makeService();
      challenges.findUnique.mockResolvedValue(
        challenge({ deliveredAt: null, consumedAt: NOW }),
      );

      await expect(preview(service, RAW_TOKEN)).rejects.toThrow(
        'This Telegram connection link is not ready',
      );
    });

    it('rejects an already consumed delivered challenge', async () => {
      const { service, challenges } = makeService();
      challenges.findUnique.mockResolvedValue(challenge({ consumedAt: NOW }));

      await expect(preview(service, RAW_TOKEN)).rejects.toThrow(
        'This Telegram connection link has already been used',
      );
    });

    it('checks consumption before expiry', async () => {
      const { service, challenges } = makeService();
      challenges.findUnique.mockResolvedValue(
        challenge({
          consumedAt: NOW,
          expiresAt: new Date(NOW.getTime() - 1),
        }),
      );

      await expect(preview(service, RAW_TOKEN)).rejects.toThrow(
        'This Telegram connection link has already been used',
      );
    });

    it('rejects expiry at the exact current time', async () => {
      const { service, challenges } = makeService();
      challenges.findUnique.mockResolvedValue(challenge({ expiresAt: NOW }));

      await expect(preview(service, RAW_TOKEN)).rejects.toThrow(
        'This Telegram connection link has expired',
      );
    });

    it('returns exact destination metadata and normalizes a missing topic to null', async () => {
      const { service, challenges } = makeService();
      const expiresAt = new Date(NOW.getTime() + 60_000);
      challenges.findUnique.mockResolvedValue(
        challenge({
          chatType: 'private',
          chatTitle: null,
          messageThreadId: null,
          expiresAt,
        }),
      );

      await expect(preview(service, RAW_TOKEN)).resolves.toEqual({
        chatId: '-1001234567890',
        chatType: 'private',
        chatTitle: null,
        messageThreadId: null,
        expiresAt,
      });
    });
  });

  describe('connect', () => {
    function prepareValidConnect() {
      const setup = makeService();
      setup.queryRaw
        .mockResolvedValueOnce([{ id: 'challenge-id' }])
        .mockResolvedValueOnce([{ id: 'membership-id' }]);
      setup.challenges.findUnique.mockResolvedValue(challenge());
      return setup;
    }

    it('locks by only the parameterized SHA-256 token hash', async () => {
      const { service, queryRaw } = prepareValidConnect();

      await connect(service, 'user-1', RAW_TOKEN, 'project-1');

      expect(queryRaw).toHaveBeenCalledTimes(2);
      const sqlParts = callArgument(queryRaw, 0, 0);
      expect(Array.isArray(sqlParts)).toBe(true);
      const sql = (sqlParts as unknown[]).join('?').replace(/\s+/g, ' ').trim();
      expect(sql).toBe(
        'SELECT "id" FROM "telegram_connection_challenges" WHERE "token_hash" = ? FOR UPDATE',
      );
      expect(callArgument(queryRaw, 0, 1)).toBe(TOKEN_HASH);
      expect(JSON.stringify(queryRaw.mock.calls)).not.toContain(RAW_TOKEN);
    });

    it('rejects a token whose lock query finds no row without fetching state', async () => {
      const { service, queryRaw, challenges } = makeService();
      queryRaw.mockResolvedValue([]);

      await expect(
        connect(service, 'user-1', RAW_TOKEN, 'project-1'),
      ).rejects.toThrow('This Telegram connection link is invalid');

      expect(challenges.findUnique).not.toHaveBeenCalled();
    });

    it('fetches and validates the exact locked challenge inside the transaction', async () => {
      const { service, challenges } = prepareValidConnect();

      await connect(service, 'user-1', RAW_TOKEN, 'project-1');

      expect(challenges.findUnique).toHaveBeenCalledWith({
        where: { id: 'challenge-id' },
      });
    });

    it.each([
      ['missing', null, 'This Telegram connection link is invalid'],
      [
        'undelivered',
        challenge({ deliveredAt: null }),
        'This Telegram connection link is not ready',
      ],
      [
        'consumed',
        challenge({ consumedAt: NOW }),
        'This Telegram connection link has already been used',
      ],
      [
        'expired',
        challenge({ expiresAt: NOW }),
        'This Telegram connection link has expired',
      ],
    ])('rejects %s locked challenge state', async (_case, row, message) => {
      const { service, queryRaw, challenges } = makeService();
      queryRaw.mockResolvedValue([{ id: 'challenge-id' }]);
      challenges.findUnique.mockResolvedValue(row);

      await expect(
        connect(service, 'user-1', RAW_TOKEN, 'project-1'),
      ).rejects.toThrow(message);
    });

    it('locks the exact membership after loading the project and before creating the channel', async () => {
      const { service, projects, memberships, notificationChannels, queryRaw } =
        prepareValidConnect();

      await connect(service, 'user-1', RAW_TOKEN, 'project-1');

      expect(projects.findUnique).toHaveBeenCalledWith({
        where: { id: 'project-1' },
      });
      const sqlParts = callArgument(queryRaw, 1, 0);
      expect(Array.isArray(sqlParts)).toBe(true);
      const sql = (sqlParts as unknown[]).join('?').replace(/\s+/g, ' ').trim();
      expect(sql).toBe(
        'SELECT "id" FROM "memberships" WHERE "user_id" = ? AND "organization_id" = ? FOR UPDATE',
      );
      expect(callArgument(queryRaw, 1, 1)).toBe('user-1');
      expect(callArgument(queryRaw, 1, 2)).toBe('organization-1');
      expect(memberships.findUnique).not.toHaveBeenCalled();
      expect(projects.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
        queryRaw.mock.invocationCallOrder[1],
      );
      expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
        notificationChannels.create.mock.invocationCallOrder[0],
      );
    });

    it('rejects a missing project with the existing authorization message', async () => {
      const { service, projects, memberships, queryRaw } =
        prepareValidConnect();
      projects.findUnique.mockResolvedValue(null);

      await expect(
        connect(service, 'user-1', RAW_TOKEN, 'project-1'),
      ).rejects.toThrow('Project not found');

      expect(memberships.findUnique).not.toHaveBeenCalled();
      expect(queryRaw).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-member with the existing authorization message', async () => {
      const {
        service,
        challenges,
        memberships,
        notificationChannels,
        queryRaw,
      } = makeService();
      queryRaw
        .mockResolvedValueOnce([{ id: 'challenge-id' }])
        .mockResolvedValueOnce([]);
      challenges.findUnique.mockResolvedValue(challenge());

      await expect(
        connect(service, 'user-1', RAW_TOKEN, 'project-1'),
      ).rejects.toThrow('Not a member of this organization');

      expect(queryRaw).toHaveBeenCalledTimes(2);
      expect(memberships.findUnique).not.toHaveBeenCalled();
      expect(notificationChannels.create).not.toHaveBeenCalled();
    });

    it('creates the exact managed topic destination then consumes the exact challenge atomically', async () => {
      const { service, challenges, notificationChannels, transaction } =
        prepareValidConnect();

      await expect(
        connect(service, 'user-1', RAW_TOKEN, 'project-1'),
      ).resolves.toEqual({
        id: 'channel-1',
        projectId: 'project-1',
        type: 'TELEGRAM',
        configJson: JSON.stringify({
          mode: 'MANAGED',
          chatId: '-1001234567890',
          chatType: 'supergroup',
          chatTitle: 'Synthetic Operations',
          messageThreadId: 42,
        }),
        enabled: true,
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      expect(callArgument(transaction, 0, 1)).toEqual({ timeout: 10_000 });
      expect(notificationChannels.create).toHaveBeenCalledWith({
        data: {
          projectId: 'project-1',
          type: 'TELEGRAM',
          destinationKey: 'chat:-1001234567890:topic:42',
          config: {
            mode: 'MANAGED',
            chatId: '-1001234567890',
            chatType: 'supergroup',
            chatTitle: 'Synthetic Operations',
            messageThreadId: 42,
          },
          enabled: true,
        },
      });
      expect(challenges.update).toHaveBeenCalledWith({
        where: { id: 'challenge-id' },
        data: { consumedAt: NOW },
      });
      expect(
        notificationChannels.create.mock.invocationCallOrder[0],
      ).toBeLessThan(challenges.update.mock.invocationCallOrder[0]);
      expect(
        JSON.stringify(notificationChannels.create.mock.calls),
      ).not.toContain(RAW_TOKEN);
    });

    it('uses root destination and omits empty title and missing topic from managed config', async () => {
      const { service, challenges, notificationChannels } =
        prepareValidConnect();
      challenges.findUnique.mockResolvedValue(
        challenge({ chatTitle: '', messageThreadId: null }),
      );
      notificationChannels.create.mockResolvedValue({
        id: 'channel-root',
        projectId: 'project-1',
        type: 'TELEGRAM',
        config: {
          mode: 'MANAGED',
          chatId: '-1001234567890',
          chatType: 'supergroup',
        },
        enabled: true,
      });

      await connect(service, 'user-1', RAW_TOKEN, 'project-1');

      expect(notificationChannels.create).toHaveBeenCalledWith({
        data: {
          projectId: 'project-1',
          type: 'TELEGRAM',
          destinationKey: 'chat:-1001234567890:topic:root',
          config: {
            mode: 'MANAGED',
            chatId: '-1001234567890',
            chatType: 'supergroup',
          },
          enabled: true,
        },
      });
    });

    it.each([
      [['projectId', 'type', 'destinationKey']],
      ['notification_channels_project_id_type_destination_key_key'],
    ])(
      'maps the exact channel destination P2002 target to a conflict and does not consume',
      async (target) => {
        const { service, challenges, notificationChannels } =
          prepareValidConnect();
        notificationChannels.create.mockRejectedValue({
          code: 'P2002',
          meta: { target },
        });

        await expect(
          connect(service, 'user-1', RAW_TOKEN, 'project-1'),
        ).rejects.toThrow(
          'This Telegram destination is already connected to that project',
        );
        expect(challenges.update).not.toHaveBeenCalled();
      },
    );

    it('does not map an unrelated P2002 and does not consume', async () => {
      const { service, challenges, notificationChannels } =
        prepareValidConnect();
      const unrelated = {
        code: 'P2002',
        meta: { target: ['token_hash'] },
      };
      notificationChannels.create.mockRejectedValue(unrelated);

      await expect(
        connect(service, 'user-1', RAW_TOKEN, 'project-1'),
      ).rejects.toBe(unrelated);
      expect(challenges.update).not.toHaveBeenCalled();
    });
  });
});
