import { randomUUID } from 'node:crypto';
import { Prisma } from '@systemvitals/database';
import { buildApp } from '../src/main';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { PrismaService } from '../src/prisma/prisma.service';
import { hashEmailVerificationToken } from '../src/channels/email-verification-token';
import {
  EmailVerificationQueueService,
  type EmailVerificationJobData,
} from '../src/queue/email-verification-queue.service';
import { cleanupTestUsers } from './cleanup-test-users';

async function signup(app: NestFastifyApplication, email: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { email, password: 'supersecret1' },
  });
  return (JSON.parse(r.body) as { token: string }).token;
}

async function gql(
  app: NestFastifyApplication,
  token: string,
  query: string,
  variables?: unknown,
) {
  const r = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { authorization: `Bearer ${token}` },
    payload: { query, variables },
  });
  return JSON.parse(r.body) as unknown;
}

interface GqlMeResponse {
  data: {
    me: {
      organizations: Array<{
        id: string;
        projects: Array<{ id: string }>;
      }>;
    };
  };
}

interface ChannelShape {
  id: string;
  type: string;
  configJson: string;
  enabled: boolean;
  organizationId: string;
  projectId: string;
  verificationStatus: string;
  verificationDeliveryStatus: string;
}

interface GqlCreateChannelResponse {
  data?: { createChannel: ChannelShape };
  errors?: Array<{ message: string }>;
}

interface GqlChannelsResponse {
  data?: { channels: ChannelShape[] };
  errors?: Array<{ message: string }>;
}

interface GqlDeleteChannelResponse {
  data?: { deleteChannel: boolean };
  errors?: Array<{ message: string }>;
}

describe('channels (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let emailVerificationQueue: EmailVerificationQueueService;
  let originalEnqueue: EmailVerificationQueueService['enqueue'];
  const capturedEmailVerificationJobs: EmailVerificationJobData[] = [];
  const suffix = randomUUID().slice(0, 8);
  const emailA = `channel-a+${suffix}@systemvitals.com`;
  const emailB = `channel-b+${suffix}@systemvitals.com`;

  function resetCapturedEmailVerificationJobs(): void {
    for (const job of capturedEmailVerificationJobs) {
      job.rawToken = '';
    }
    capturedEmailVerificationJobs.length = 0;
  }

  beforeAll(async () => {
    app = await buildApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    emailVerificationQueue = app.get(EmailVerificationQueueService);
    originalEnqueue = emailVerificationQueue.enqueue.bind(
      emailVerificationQueue,
    );
    emailVerificationQueue.enqueue = (job) => {
      capturedEmailVerificationJobs.push({ ...job });
      return Promise.resolve();
    };
    await cleanupTestUsers(prisma, [emailA, emailB]);
  });

  afterAll(async () => {
    try {
      await cleanupTestUsers(prisma, [emailA, emailB]);
    } finally {
      emailVerificationQueue.enqueue = originalEnqueue;
      resetCapturedEmailVerificationJobs();
      await app.close();
    }
  });

  let tokenA: string;
  let organizationIdA: string;
  let projectIdA: string;
  let channelId: string;

  it('signup → me → get default projectId', async () => {
    tokenA = await signup(app, emailA);
    const me = (await gql(
      app,
      tokenA,
      `{ me { organizations { id projects { id } } } }`,
    )) as GqlMeResponse;
    organizationIdA = me.data.me.organizations[0].id;
    projectIdA = me.data.me.organizations[0].projects[0].id;
    expect(projectIdA).toBeTruthy();
  });

  it('createChannel returns a pending EMAIL channel after enqueue', async () => {
    resetCapturedEmailVerificationJobs();
    const res = (await gql(
      app,
      tokenA,
      `mutation($organizationId: ID!, $type: String!, $configJson: String!) {
        createChannel(organizationId: $organizationId, type: $type, configJson: $configJson) {
          id type configJson enabled organizationId projectId
          verificationStatus verificationDeliveryStatus
        }
      }`,
      {
        organizationId: organizationIdA,
        type: 'EMAIL',
        configJson: '{"email":"ops@example.com"}',
      },
    )) as GqlCreateChannelResponse;

    try {
      expect(res.errors).toBeUndefined();
      const channel = res.data!.createChannel;
      expect(channel.type).toBe('EMAIL');
      expect(channel.enabled).toBe(false);
      expect(channel.verificationStatus).toBe('PENDING');
      expect(channel.verificationDeliveryStatus).toBe('SENT');
      expect(channel.organizationId).toBe(organizationIdA);
      expect(channel.projectId).toBe(projectIdA);
      const parsed = JSON.parse(channel.configJson) as {
        email: string;
      };
      expect(parsed.email).toBe('ops@example.com');

      expect(capturedEmailVerificationJobs).toHaveLength(1);
      const capturedJob = capturedEmailVerificationJobs[0];
      expect(capturedJob.channelId).toBe(channel.id);
      expect(capturedJob.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(capturedJob.rawToken).not.toMatch(/^[a-f0-9]{64}$/);

      const persisted = await prisma.notificationChannel.findUniqueOrThrow({
        where: { id: channel.id },
        select: { verificationTokenHash: true },
      });
      expect(persisted.verificationTokenHash).toMatch(/^[a-f0-9]{64}$/);
      expect(hashEmailVerificationToken(capturedJob.rawToken)).toBe(
        persisted.verificationTokenHash,
      );
      channelId = channel.id;
    } finally {
      resetCapturedEmailVerificationJobs();
    }
  });

  it('channels(projectId) lists the created channel', async () => {
    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        channels(projectId: $projectId) {
          id type enabled verificationStatus verificationDeliveryStatus
        }
      }`,
      { projectId: projectIdA },
    )) as GqlChannelsResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.channels.length).toBeGreaterThanOrEqual(1);
    const ch = res.data?.channels.find((c) => c.id === channelId);
    expect(ch).toBeDefined();
    expect(ch?.type).toBe('EMAIL');
    expect(ch?.enabled).toBe(false);
    expect(ch?.verificationStatus).toBe('PENDING');
    expect(ch?.verificationDeliveryStatus).toBe('SENT');
  });

  it.each([
    ['both', { organizationId: 'org', projectId: 'project' }],
    ['neither', {}],
  ])('rejects %s workspace selector for channels', async (_case, variables) => {
    const res = (await gql(
      app,
      tokenA,
      `query($organizationId: ID, $projectId: ID) {
        channels(organizationId: $organizationId, projectId: $projectId) { id }
      }`,
      variables,
    )) as GqlChannelsResponse;

    expect(res.errors?.[0]?.message).toBe(
      'Provide exactly one of organizationId or projectId',
    );
  });

  it('does not disclose another user organization during canonical create', async () => {
    const tokenB = await signup(app, emailB);
    const res = (await gql(
      app,
      tokenB,
      `mutation($organizationId: ID!, $type: String!, $configJson: String!) {
        createChannel(organizationId: $organizationId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        organizationId: organizationIdA,
        type: 'EMAIL',
        configJson: '{"email":"intruder@example.com"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toBe('Workspace not found');
  });

  it('createChannel with EMAIL but missing config.email → errors', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        type: 'EMAIL',
        configJson: '{"webhook":"https://example.com"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/email/i);
  });

  it('createChannel with BOGUS type → errors with invalid channel type', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        type: 'BOGUS',
        configJson: '{"email":"x@y.com"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/invalid channel type/i);
  });

  it('createChannel with SLACK type and webhookUrl → ok (returns masked URL, not secret path)', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id type configJson enabled projectId
        }
      }`,
      {
        projectId: projectIdA,
        type: 'SLACK',
        configJson: '{"webhookUrl":"https://hooks.slack.com/services/SECRET"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createChannel.type).toBe('SLACK');
    const parsed = JSON.parse(res.data!.createChannel.configJson) as {
      webhookUrl: string;
    };
    // Only scheme+host returned; secret path must be absent
    expect(parsed.webhookUrl).toBe('https://hooks.slack.com/…');
    expect(res.data!.createChannel.configJson).not.toContain('SECRET');
  });

  it('rejects generic TELEGRAM creation before parsing caller config', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id type configJson enabled projectId
        }
      }`,
      {
        projectId: projectIdA,
        type: 'TELEGRAM',
        configJson: 'not-json-and-must-not-be-parsed',
      },
    )) as GqlCreateChannelResponse;

    expect(res.data).toBeNull();
    expect(res.errors?.[0]?.message).toBe(
      'Telegram channels require the managed bot connection flow',
    );
  });

  it('lists a directly seeded legacy TELEGRAM channel without its token or unknown fields', async () => {
    const legacy = await prisma.notificationChannel.create({
      data: {
        projectId: projectIdA,
        type: 'TELEGRAM',
        config: {
          botToken: 'legacy-secret',
          chatId: '-100123',
          messageThreadId: 42,
          unknown: 'must-not-leak',
        },
        enabled: true,
      },
    });

    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        channels(projectId: $projectId) { id type configJson enabled projectId }
      }`,
      { projectId: projectIdA },
    )) as GqlChannelsResponse;

    expect(res.errors).toBeUndefined();
    const listed = res.data?.channels.find(({ id }) => id === legacy.id);
    expect(listed).toBeDefined();
    expect(JSON.parse(listed!.configJson)).toEqual({
      mode: 'LEGACY',
      chatId: '-100123',
      messageThreadId: 42,
    });
    expect(listed!.configJson).not.toContain('legacy-secret');
    expect(listed!.configJson).not.toContain('botToken');
    expect(listed!.configJson).not.toContain('unknown');
  });

  it('lists a managed TELEGRAM channel with metadata and no unknown fields', async () => {
    const managed = await prisma.notificationChannel.create({
      data: {
        projectId: projectIdA,
        type: 'TELEGRAM',
        destinationKey: 'chat:-100456:topic:root',
        config: {
          mode: 'MANAGED',
          chatId: '-100456',
          chatType: 'supergroup',
          chatTitle: 'Operations',
          ignoredSecret: 'must-not-leak',
        },
        enabled: true,
      },
    });

    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        channels(projectId: $projectId) { id type configJson }
      }`,
      { projectId: projectIdA },
    )) as GqlChannelsResponse;

    const listed = res.data?.channels.find(({ id }) => id === managed.id);
    expect(JSON.parse(listed!.configJson)).toEqual({
      mode: 'MANAGED',
      chatId: '-100456',
      chatType: 'supergroup',
      chatTitle: 'Operations',
    });
    expect(listed!.configJson).not.toContain('ignoredSecret');
  });

  it('does not leak nested secrets from malformed TELEGRAM config fields', async () => {
    const malformed = await prisma.notificationChannel.create({
      data: {
        projectId: projectIdA,
        type: 'TELEGRAM',
        config: {
          botToken: { nested: 'not-a-legacy-token' },
          chatId: { botToken: 'nested-secret' },
          chatType: 123,
          chatTitle: { secret: 'hidden' },
          messageThreadId: '42',
        },
        enabled: true,
      },
    });

    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        channels(projectId: $projectId) { id configJson }
      }`,
      { projectId: projectIdA },
    )) as GqlChannelsResponse;

    const listed = res.data?.channels.find(({ id }) => id === malformed.id);
    expect(JSON.parse(listed!.configJson)).toEqual({
      mode: 'MANAGED',
      chatId: '',
    });
    expect(listed!.configJson).not.toContain('botToken');
    expect(listed!.configJson).not.toContain('nested-secret');
    expect(listed!.configJson).not.toContain('hidden');
  });

  it('lists invalid top-level TELEGRAM configs as safe minimal managed config', async () => {
    const secretMarker = `top-level-secret-${randomUUID()}`;
    const configs = [
      Prisma.JsonNull,
      [secretMarker, { botToken: secretMarker }],
      secretMarker,
      42,
      true,
      false,
    ];
    const rows = await Promise.all(
      configs.map((config) =>
        prisma.notificationChannel.create({
          data: {
            projectId: projectIdA,
            type: 'TELEGRAM',
            config,
            enabled: true,
          },
        }),
      ),
    );

    const res = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) {
        channels(projectId: $projectId) { id configJson }
      }`,
      { projectId: projectIdA },
    )) as GqlChannelsResponse;

    expect(res.errors).toBeUndefined();
    const listedConfigs = rows.map(({ id }) => {
      const listed = res.data?.channels.find((channel) => channel.id === id);
      expect(listed).toBeDefined();
      return listed!.configJson;
    });
    expect(
      listedConfigs.map((configJson) => JSON.parse(configJson) as unknown),
    ).toEqual(configs.map(() => ({ mode: 'MANAGED', chatId: '' })));
    expect(listedConfigs.join('')).not.toContain(secretMarker);
    expect(listedConfigs.join('')).not.toContain('botToken');
  });

  it('createChannel with WEBHOOK type and url → ok (returns masked URL, not secret path)', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id type configJson enabled projectId
        }
      }`,
      {
        projectId: projectIdA,
        type: 'WEBHOOK',
        configJson: '{"url":"https://ex.com/hook/secret-path"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeUndefined();
    expect(res.data?.createChannel.type).toBe('WEBHOOK');
    const parsed = JSON.parse(res.data!.createChannel.configJson) as {
      url: string;
    };
    // Only scheme+host returned; secret path must be absent
    expect(parsed.url).toBe('https://ex.com/…');
    expect(res.data!.createChannel.configJson).not.toContain('secret-path');
  });

  it('createChannel with SLACK but missing webhookUrl → error matching /webhookUrl/i', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        type: 'SLACK',
        configJson: '{"other":"value"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/webhookUrl/i);
  });

  it('createChannel with WEBHOOK but missing url → error matching /config[.]url/i', async () => {
    const res = (await gql(
      app,
      tokenA,
      `mutation($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
        }
      }`,
      {
        projectId: projectIdA,
        type: 'WEBHOOK',
        configJson: '{"other":"value"}',
      },
    )) as GqlCreateChannelResponse;

    expect(res.errors).toBeDefined();
    expect(res.errors?.[0]?.message).toMatch(/config[.]url/i);
  });

  it('deleteChannel returns true and channel disappears from list', async () => {
    const deleteRes = (await gql(
      app,
      tokenA,
      `mutation($id: ID!) { deleteChannel(id: $id) }`,
      { id: channelId },
    )) as GqlDeleteChannelResponse;

    expect(deleteRes.errors).toBeUndefined();
    expect(deleteRes.data?.deleteChannel).toBe(true);

    const listRes = (await gql(
      app,
      tokenA,
      `query($projectId: ID!) { channels(projectId: $projectId) { id } }`,
      { projectId: projectIdA },
    )) as GqlChannelsResponse;
    const ids = listRes.data?.channels.map((c) => c.id) ?? [];
    expect(ids).not.toContain(channelId);
  });
});
