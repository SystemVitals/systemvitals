import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@systemvitals/database';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { buildApp } from '../src/main';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { TelegramBotClient } from '../src/telegram/telegram-bot.client';
import {
  TELEGRAM_PENDING_DELIVERY_LEASE_MS,
  TelegramConnectionsService,
} from '../src/telegram/telegram-connections.service';
import type { TelegramStartUpdate } from '../src/telegram/telegram-update';
import { cleanupTestUsers } from './cleanup-test-users';
import { generateToken } from '../src/tokens/token.util';

jest.setTimeout(30_000);

const prisma = new PrismaClient();
const cleanupChatIds = new Set<string>();

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

function syntheticChatId(): string {
  const suffix = randomBytes(5).readUIntBE(0, 5);
  const chatId = `-100${suffix}`;
  cleanupChatIds.add(chatId);
  return chatId;
}

function config(): ConfigService {
  return {
    get: jest.fn((key: string) => {
      if (key === 'APP_URL') return 'https://app.example.test';
      if (key === 'NODE_ENV') return 'test';
      return undefined;
    }),
  } as unknown as ConfigService;
}

type SendMessage = jest.MockedFunction<TelegramBotClient['sendMessage']>;
type InteractiveTransaction = (
  callback: (client: Prisma.TransactionClient) => Promise<unknown>,
  options?: {
    maxWait?: number;
    timeout?: number;
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
) => Promise<unknown>;

function service(
  database: PrismaService,
  sendMessage: SendMessage,
): TelegramConnectionsService {
  return new TelegramConnectionsService(
    database,
    { sendMessage } as unknown as TelegramBotClient,
    config(),
  );
}

function startUpdate(
  chatId: string,
  updateId: string,
  messageThreadId?: number,
): TelegramStartUpdate {
  return {
    updateId,
    chatId,
    chatType: 'supergroup',
    chatTitle: 'Synthetic PostgreSQL destination',
    messageThreadId,
  };
}

afterEach(async () => {
  const chatIds = [...cleanupChatIds];
  cleanupChatIds.clear();
  if (chatIds.length > 0) {
    await prisma.telegramConnectionChallenge.deleteMany({
      where: { chatId: { in: chatIds } },
    });
  }
});

describe('TelegramConnectionsService PostgreSQL concurrency', () => {
  it('limits seven concurrent unique starts for one destination to six rows and replies', async () => {
    const chatId = syntheticChatId();
    const messageThreadId = 42;
    const updates = Array.from({ length: 7 }, (_, index) =>
      startUpdate(
        chatId,
        `telegram-concurrent-${randomUUID()}-${index}`,
        messageThreadId,
      ),
    );
    const sendMessage = jest
      .fn()
      .mockResolvedValue({ message_id: 123456 }) as SendMessage;
    const connections = service(
      prisma as unknown as PrismaService,
      sendMessage,
    );

    await Promise.all(updates.map((update) => connections.handleStart(update)));

    const rows = await prisma.telegramConnectionChallenge.findMany({
      where: { chatId, messageThreadId },
    });
    expect(rows).toHaveLength(6);
    expect(
      new Set(rows.map(({ telegramUpdateId }) => telegramUpdateId)).size,
    ).toBe(6);
    expect(rows.every(({ deliveredAt }) => deliveredAt !== null)).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(6);
  });

  it('replaces a pending row after failed send and failed rollback, then delivers once', async () => {
    const chatId = syntheticChatId();
    const update = startUpdate(chatId, `telegram-retry-${randomUUID()}`);
    const failedSend = jest
      .fn()
      .mockRejectedValue(
        new Error('synthetic transport failure'),
      ) as SendMessage;
    const challengeDelegate = prisma.telegramConnectionChallenge;
    const forcedDelete = jest
      .fn()
      .mockRejectedValue(new Error('synthetic rollback failure'));
    const rollbackFailurePrisma = {
      $transaction: prisma.$transaction.bind(prisma),
      telegramConnectionChallenge: {
        deleteMany: challengeDelegate.deleteMany.bind(challengeDelegate),
        delete: forcedDelete,
        updateMany: challengeDelegate.updateMany.bind(challengeDelegate),
      },
    } as unknown as PrismaService;

    await expect(
      service(rollbackFailurePrisma, failedSend).handleStart(update),
    ).rejects.toThrow('Telegram challenge reply failed');

    const pending = await prisma.telegramConnectionChallenge.findUniqueOrThrow({
      where: { telegramUpdateId: update.updateId },
    });
    expect(pending.deliveredAt).toBeNull();
    expect(forcedDelete).toHaveBeenCalledWith({
      where: { id: pending.id },
    });
    await prisma.telegramConnectionChallenge.update({
      where: { id: pending.id },
      data: {
        createdAt: new Date(
          Date.now() - TELEGRAM_PENDING_DELIVERY_LEASE_MS - 1_000,
        ),
      },
    });

    const successfulSend = jest
      .fn()
      .mockResolvedValue({ message_id: 123457 }) as SendMessage;
    await service(
      prisma as unknown as PrismaService,
      successfulSend,
    ).handleStart(update);

    const rows = await prisma.telegramConnectionChallenge.findMany({
      where: { telegramUpdateId: update.updateId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(pending.id);
    expect(rows[0].deliveredAt).not.toBeNull();
    expect(successfulSend).toHaveBeenCalledTimes(1);
  });

  it('keeps one active pending row and one outbound call during an overlapping duplicate', async () => {
    const chatId = syntheticChatId();
    const update = startUpdate(
      chatId,
      `telegram-active-pending-${randomUUID()}`,
    );
    const firstSendStarted = deferred<void>();
    const releaseFirstSend = deferred<{ message_id: number }>();
    const firstSend = jest.fn(
      (input: Parameters<TelegramBotClient['sendMessage']>[0]) => {
        expect(input.chatId).toBe(chatId);
        firstSendStarted.resolve(undefined);
        return releaseFirstSend.promise;
      },
    ) as SendMessage;
    const secondSend = jest
      .fn()
      .mockResolvedValue({ message_id: 123459 }) as SendMessage;
    const firstConnections = service(
      prisma as unknown as PrismaService,
      firstSend,
    );
    const secondConnections = service(
      prisma as unknown as PrismaService,
      secondSend,
    );

    const firstHandling = firstConnections.handleStart(update);
    await firstSendStarted.promise;

    await expect(secondConnections.handleStart(update)).rejects.toThrow(
      'Telegram challenge delivery in progress',
    );
    const pendingRows = await prisma.telegramConnectionChallenge.findMany({
      where: { telegramUpdateId: update.updateId },
    });
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0].deliveredAt).toBeNull();
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).not.toHaveBeenCalled();

    releaseFirstSend.resolve({ message_id: 123456 });
    await expect(firstHandling).resolves.toBeUndefined();

    const deliveredRows = await prisma.telegramConnectionChallenge.findMany({
      where: { telegramUpdateId: update.updateId },
    });
    expect(deliveredRows).toHaveLength(1);
    expect(deliveredRows[0].id).toBe(pendingRows[0].id);
    expect(deliveredRows[0].deliveredAt).not.toBeNull();
    expect(firstSend).toHaveBeenCalledTimes(1);
    expect(secondSend).not.toHaveBeenCalled();
  });

  it('uses actual Prisma duplicate-update metadata to retry and replace pending state', async () => {
    const chatId = syntheticChatId();
    const update = startUpdate(chatId, `telegram-p2002-${randomUUID()}`);
    const pending = await prisma.telegramConnectionChallenge.create({
      data: {
        tokenHash: randomBytes(32).toString('hex'),
        telegramUpdateId: update.updateId,
        chatId,
        chatType: update.chatType,
        chatTitle: update.chatTitle,
        messageThreadId: null,
        expiresAt: new Date(Date.now() + 600_000),
        deliveredAt: null,
      },
    });
    let actualDuplicateError: unknown;
    try {
      await prisma.telegramConnectionChallenge.create({
        data: {
          tokenHash: randomBytes(32).toString('hex'),
          telegramUpdateId: update.updateId,
          chatId,
          chatType: update.chatType,
          chatTitle: update.chatTitle,
          messageThreadId: null,
          expiresAt: new Date(Date.now() + 600_000),
          deliveredAt: null,
        },
      });
    } catch (error) {
      actualDuplicateError = error;
    }
    expect(actualDuplicateError).toMatchObject({ code: 'P2002' });
    await prisma.telegramConnectionChallenge.update({
      where: { id: pending.id },
      data: {
        createdAt: new Date(
          Date.now() - TELEGRAM_PENDING_DELIVERY_LEASE_MS - 1_000,
        ),
      },
    });

    const transaction = jest.fn<
      ReturnType<InteractiveTransaction>,
      Parameters<InteractiveTransaction>
    >();
    transaction
      .mockRejectedValueOnce(actualDuplicateError)
      .mockImplementation((callback, options) =>
        prisma.$transaction(callback, options),
      );
    const challengeDelegate = prisma.telegramConnectionChallenge;
    const retryPrisma = {
      $transaction: transaction,
      telegramConnectionChallenge: {
        deleteMany: challengeDelegate.deleteMany.bind(challengeDelegate),
        delete: challengeDelegate.delete.bind(challengeDelegate),
        updateMany: challengeDelegate.updateMany.bind(challengeDelegate),
      },
    } as unknown as PrismaService;
    const sendMessage = jest
      .fn()
      .mockResolvedValue({ message_id: 123458 }) as SendMessage;

    await service(retryPrisma, sendMessage).handleStart(update);

    const rows = await prisma.telegramConnectionChallenge.findMany({
      where: { telegramUpdateId: update.updateId },
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(pending.id);
    expect(rows[0].deliveredAt).not.toBeNull();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

interface GqlResponse<T> {
  data?: T | null;
  errors?: Array<{ message: string }>;
}

interface ChannelResult {
  id: string;
  type: string;
  configJson: string;
  enabled: boolean;
  organizationId: string;
  projectId: string;
}

async function signup(
  app: NestFastifyApplication,
  email: string,
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(response.body) as { token: string }).token;
}

async function gql<T>(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
): Promise<GqlResponse<T>> {
  const response = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(response.body) as GqlResponse<T>;
}

const PREVIEW = `
  query($token: String!) {
    telegramConnectionPreview(token: $token) {
      chatId chatType chatTitle messageThreadId expiresAt
    }
  }
`;
const CONNECT = `
  mutation($token: String!, $organizationId: ID, $projectId: ID) {
    connectTelegramChannel(
      token: $token
      organizationId: $organizationId
      projectId: $projectId
    ) {
      id type configJson enabled organizationId projectId
    }
  }
`;

describe('managed Telegram connection GraphQL (e2e)', () => {
  let app: NestFastifyApplication;
  let ownerToken: string;
  let otherToken: string;
  let ownerUserId: string;
  let otherUserId: string;
  let ownerOrganizationId: string;
  let ownerProjectId: string;
  const challengeHashes = new Set<string>();
  const challengeUpdateIds = new Set<string>();
  const suffix = randomUUID().slice(0, 8);
  const ownerEmail = `telegram-owner+${suffix}@systemvitals.com`;
  const otherEmail = `telegram-other+${suffix}@systemvitals.com`;

  async function insertChallenge(
    overrides: Partial<{
      chatId: string;
      chatType: string;
      chatTitle: string | null;
      messageThreadId: number | null;
      expiresAt: Date;
      deliveredAt: Date | null;
      consumedAt: Date | null;
    }> = {},
  ) {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const telegramUpdateId = `managed-e2e-${randomUUID()}`;
    challengeHashes.add(tokenHash);
    challengeUpdateIds.add(telegramUpdateId);
    const row = await prisma.telegramConnectionChallenge.create({
      data: {
        tokenHash,
        telegramUpdateId,
        chatId: `-100${randomBytes(5).readUIntBE(0, 5)}`,
        chatType: 'supergroup',
        chatTitle: 'Managed E2E Operations',
        messageThreadId: null,
        expiresAt: new Date(Date.now() + 600_000),
        deliveredAt: new Date(),
        consumedAt: null,
        ...overrides,
      },
    });
    return { rawToken, tokenHash, row };
  }

  async function createApiToken(
    scopes: string[],
    projectId: string | null,
  ): Promise<string> {
    const generated = generateToken();
    await prisma.apiToken.create({
      data: {
        name: `telegram-e2e-${randomUUID()}`,
        prefix: generated.prefix,
        tokenHash: generated.hash,
        scopes,
        userId: ownerUserId,
        projectId,
      },
    });
    return generated.plaintext;
  }

  beforeAll(async () => {
    await cleanupTestUsers(prisma as unknown as PrismaService, [
      ownerEmail,
      otherEmail,
    ]);
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    ownerToken = await signup(app, ownerEmail);
    otherToken = await signup(app, otherEmail);
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
      include: {
        memberships: {
          include: {
            organization: { include: { projects: true } },
          },
        },
      },
    });
    ownerUserId = owner.id;
    ownerOrganizationId = owner.memberships[0].organization.id;
    ownerProjectId = owner.memberships[0].organization.projects[0].id;
    otherUserId = (
      await prisma.user.findUniqueOrThrow({
        where: { email: otherEmail },
        select: { id: true },
      })
    ).id;
  });

  afterEach(async () => {
    const hashes = [...challengeHashes];
    const updateIds = [...challengeUpdateIds];
    challengeHashes.clear();
    challengeUpdateIds.clear();
    if (hashes.length > 0 || updateIds.length > 0) {
      await prisma.telegramConnectionChallenge.deleteMany({
        where: {
          OR: [
            { tokenHash: { in: hashes } },
            { telegramUpdateId: { in: updateIds } },
          ],
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma as unknown as PrismaService, [
        ownerEmail,
        otherEmail,
      ]);
    } finally {
      await app.close();
    }
  });

  it('previews and connects a delivered root destination, exposes exact managed config, and rejects replay', async () => {
    const { rawToken, tokenHash, row } = await insertChallenge({
      chatType: 'private',
      chatTitle: null,
    });

    const preview = await gql<{
      telegramConnectionPreview: {
        chatId: string;
        chatType: string;
        chatTitle: string | null;
        messageThreadId: number | null;
        expiresAt: string;
      };
    }>(app, ownerToken, PREVIEW, { token: rawToken });
    expect(preview.errors).toBeUndefined();
    expect(preview.data?.telegramConnectionPreview).toEqual({
      chatId: row.chatId,
      chatType: 'private',
      chatTitle: null,
      messageThreadId: null,
      expiresAt: row.expiresAt.toISOString(),
    });

    const connected = await gql<{
      connectTelegramChannel: ChannelResult;
    }>(app, ownerToken, CONNECT, {
      token: rawToken,
      organizationId: ownerOrganizationId,
    });
    expect(connected.errors).toBeUndefined();
    const channel = connected.data!.connectTelegramChannel;
    expect(channel).toMatchObject({
      type: 'TELEGRAM',
      enabled: true,
      organizationId: ownerOrganizationId,
      projectId: ownerProjectId,
    });
    expect(JSON.parse(channel.configJson)).toEqual({
      mode: 'MANAGED',
      chatId: row.chatId,
      chatType: 'private',
    });
    expect(channel.configJson).not.toContain(rawToken);
    expect(channel.configJson).not.toContain(tokenHash);
    const persistedChannel = await prisma.notificationChannel.findUniqueOrThrow(
      { where: { id: channel.id } },
    );
    expect(persistedChannel.destinationKey).toBe(
      `chat:${row.chatId}:topic:root`,
    );
    expect(persistedChannel.config).toEqual({
      mode: 'MANAGED',
      chatId: row.chatId,
      chatType: 'private',
    });

    const replay = await gql(app, ownerToken, CONNECT, {
      token: rawToken,
      organizationId: ownerOrganizationId,
    });
    expect(replay.errors?.[0]?.message).toBe(
      'This Telegram connection link has already been used',
    );
  });

  it('rejects both/neither selectors without consuming the challenge', async () => {
    const { rawToken, row } = await insertChallenge();

    for (const variables of [
      {
        token: rawToken,
        organizationId: ownerOrganizationId,
        projectId: ownerProjectId,
      },
      { token: rawToken },
    ]) {
      const response = await gql(app, ownerToken, CONNECT, variables);
      expect(response.errors?.[0]?.message).toBe(
        'Provide exactly one of organizationId or projectId',
      );
    }

    await expect(
      prisma.telegramConnectionChallenge.findUniqueOrThrow({
        where: { id: row.id },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: null });
  });

  it('connects a topic destination with its exact key and secret-free config', async () => {
    const { rawToken, tokenHash, row } = await insertChallenge({
      messageThreadId: 42,
      chatTitle: 'Forum Operations',
    });

    const connected = await gql<{
      connectTelegramChannel: ChannelResult;
    }>(app, ownerToken, CONNECT, {
      token: rawToken,
      projectId: ownerProjectId,
    });

    expect(connected.errors).toBeUndefined();
    const channel = connected.data!.connectTelegramChannel;
    expect(JSON.parse(channel.configJson)).toEqual({
      mode: 'MANAGED',
      chatId: row.chatId,
      chatType: 'supergroup',
      chatTitle: 'Forum Operations',
      messageThreadId: 42,
    });
    expect(channel.configJson).not.toContain(rawToken);
    expect(channel.configJson).not.toContain(tokenHash);
    await expect(
      prisma.notificationChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { destinationKey: true },
      }),
    ).resolves.toEqual({
      destinationKey: `chat:${row.chatId}:topic:42`,
    });
  });

  it.each([
    [
      'undelivered',
      { deliveredAt: null },
      'This Telegram connection link is not ready',
    ],
    [
      'expired',
      { expiresAt: new Date(Date.now() - 1) },
      'This Telegram connection link has expired',
    ],
    [
      'consumed',
      { consumedAt: new Date() },
      'This Telegram connection link has already been used',
    ],
  ])(
    'rejects %s links for both preview and connect',
    async (_case, state, message) => {
      const { rawToken } = await insertChallenge(state);

      for (const operation of [PREVIEW, CONNECT]) {
        const response = await gql(app, ownerToken, operation, {
          token: rawToken,
          projectId: ownerProjectId,
        });
        expect(response.errors?.[0]?.message).toBe(message);
      }
    },
  );

  it('rejects an invalid link for both preview and connect', async () => {
    const rawToken = randomBytes(32).toString('base64url');

    for (const operation of [PREVIEW, CONNECT]) {
      const response = await gql(app, ownerToken, operation, {
        token: rawToken,
        projectId: ownerProjectId,
      });
      expect(response.errors?.[0]?.message).toBe(
        'This Telegram connection link is invalid',
      );
    }
  });

  it('does not disclose another user organization or consume its challenge', async () => {
    const { rawToken, row } = await insertChallenge();

    const response = await gql(app, otherToken, CONNECT, {
      token: rawToken,
      organizationId: ownerOrganizationId,
    });

    expect(response.errors?.[0]?.message).toBe('Workspace not found');
    await expect(
      prisma.telegramConnectionChallenge.findUniqueOrThrow({
        where: { id: row.id },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: null });
  });

  it('holds the membership lock through connect so deletion linearizes after channel creation', async () => {
    const membership = await prisma.membership.create({
      data: {
        userId: otherUserId,
        organizationId: ownerOrganizationId,
        role: 'MEMBER',
      },
    });
    const first = await insertChallenge();
    const membershipLocked = deferred<void>();
    const releaseConnect = deferred<void>();
    let queryCount = 0;
    const hookedPrisma = {
      $transaction: (
        callback: (client: Prisma.TransactionClient) => Promise<unknown>,
        options?: Parameters<InteractiveTransaction>[1],
      ) =>
        prisma.$transaction(async (tx) => {
          const queryRaw = tx.$queryRaw.bind(tx);
          const transactionClient = {
            telegramConnectionChallenge: tx.telegramConnectionChallenge,
            project: tx.project,
            notificationChannel: tx.notificationChannel,
            $queryRaw: async (
              query: TemplateStringsArray | Prisma.Sql,
              ...values: unknown[]
            ) => {
              const result = await queryRaw(query, ...values);
              queryCount += 1;
              if (queryCount === 2) {
                membershipLocked.resolve(undefined);
                await releaseConnect.promise;
              }
              return result;
            },
          } as unknown as Prisma.TransactionClient;
          return callback(transactionClient);
        }, options),
    } as unknown as PrismaService;
    const sendMessage = jest.fn() as SendMessage;

    const connecting = service(hookedPrisma, sendMessage).connect(
      otherUserId,
      first.rawToken,
      ownerProjectId,
    );
    await membershipLocked.promise;

    let deletionSettled = false;
    const deleting = prisma.membership
      .delete({ where: { id: membership.id } })
      .finally(() => {
        deletionSettled = true;
      });
    const deletionBeforeCommit = await Promise.race([
      deleting.then(() => 'settled' as const),
      new Promise<'blocked'>((resolve) => {
        setTimeout(() => resolve('blocked'), 50);
      }),
    ]);
    expect(deletionBeforeCommit).toBe('blocked');
    expect(deletionSettled).toBe(false);

    releaseConnect.resolve(undefined);
    const channel = await connecting;
    await deleting;

    expect(queryCount).toBe(2);
    expect(channel.projectId).toBe(ownerProjectId);
    await expect(
      prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: otherUserId,
            organizationId: ownerOrganizationId,
          },
        },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.notificationChannel.count({
        where: {
          projectId: ownerProjectId,
          destinationKey: `chat:${first.row.chatId}:topic:root`,
        },
      }),
    ).resolves.toBe(1);

    const afterRevocation = await insertChallenge();
    await expect(
      service(prisma as unknown as PrismaService, sendMessage).connect(
        otherUserId,
        afterRevocation.rawToken,
        ownerProjectId,
      ),
    ).rejects.toThrow('Not a member of this organization');
    await expect(
      prisma.telegramConnectionChallenge.findUniqueOrThrow({
        where: { id: afterRevocation.row.id },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: null });
    await expect(
      prisma.notificationChannel.count({
        where: {
          projectId: ownerProjectId,
          destinationKey: `chat:${afterRevocation.row.chatId}:topic:root`,
        },
      }),
    ).resolves.toBe(0);
  });

  it('denies connect when membership deletion commits first', async () => {
    const membership = await prisma.membership.create({
      data: {
        userId: otherUserId,
        organizationId: ownerOrganizationId,
        role: 'MEMBER',
      },
    });
    const challenge = await insertChallenge();
    await prisma.membership.delete({ where: { id: membership.id } });

    await expect(
      service(
        prisma as unknown as PrismaService,
        jest.fn() as SendMessage,
      ).connect(otherUserId, challenge.rawToken, ownerProjectId),
    ).rejects.toThrow('Not a member of this organization');
    await expect(
      prisma.telegramConnectionChallenge.findUniqueOrThrow({
        where: { id: challenge.row.id },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: null });
    await expect(
      prisma.notificationChannel.count({
        where: {
          projectId: ownerProjectId,
          destinationKey: `chat:${challenge.row.chatId}:topic:root`,
        },
      }),
    ).resolves.toBe(0);
  });

  it('denies scoped and legacy-broad API tokens before preview or consumption', async () => {
    const scoped = await createApiToken(
      ['checks:read', 'checks:write'],
      ownerProjectId,
    );
    const legacy = await createApiToken(['read', 'write'], null);

    const managedBot = await gql<{
      managedTelegramBot: { available: boolean; username: string | null };
    }>(app, scoped, `{ managedTelegramBot { available username } }`);
    expect(managedBot.errors).toBeUndefined();
    expect(managedBot.data?.managedTelegramBot).toEqual({
      available: false,
      username: null,
    });

    for (const apiToken of [scoped, legacy]) {
      for (const operation of [PREVIEW, CONNECT]) {
        const { rawToken, row } = await insertChallenge();
        const response = await gql(app, apiToken, operation, {
          token: rawToken,
          projectId: ownerProjectId,
        });
        expect(response.errors?.[0]?.message).toBe('Account session required');
        await expect(
          prisma.telegramConnectionChallenge.findUniqueOrThrow({
            where: { id: row.id },
            select: { consumedAt: true },
          }),
        ).resolves.toEqual({ consumedAt: null });
      }
    }
  });

  it('maps duplicate destinations to conflict and leaves the second challenge unconsumed', async () => {
    const chatId = `-100${randomBytes(5).readUIntBE(0, 5)}`;
    const first = await insertChallenge({ chatId });
    const second = await insertChallenge({ chatId });
    await gql(app, ownerToken, CONNECT, {
      token: first.rawToken,
      projectId: ownerProjectId,
    });

    const duplicate = await gql(app, ownerToken, CONNECT, {
      token: second.rawToken,
      projectId: ownerProjectId,
    });

    expect(duplicate.errors?.[0]?.message).toBe(
      'This Telegram destination is already connected to that project',
    );
    await expect(
      prisma.telegramConnectionChallenge.findUniqueOrThrow({
        where: { id: second.row.id },
        select: { consumedAt: true },
      }),
    ).resolves.toEqual({ consumedAt: null });
  });

  it('serializes concurrent consumers so exactly one creates a channel and the other sees used', async () => {
    const { rawToken, row } = await insertChallenge();

    const responses = await Promise.all([
      gql<{ connectTelegramChannel: ChannelResult }>(app, ownerToken, CONNECT, {
        token: rawToken,
        projectId: ownerProjectId,
      }),
      gql<{ connectTelegramChannel: ChannelResult }>(app, ownerToken, CONNECT, {
        token: rawToken,
        projectId: ownerProjectId,
      }),
    ]);

    const successes = responses.filter(
      (response) => response.data?.connectTelegramChannel,
    );
    const failures = responses.filter((response) => response.errors);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].errors?.[0]?.message).toBe(
      'This Telegram connection link has already been used',
    );
    await expect(
      prisma.notificationChannel.count({
        where: {
          projectId: ownerProjectId,
          destinationKey: `chat:${row.chatId}:topic:root`,
        },
      }),
    ).resolves.toBe(1);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});
