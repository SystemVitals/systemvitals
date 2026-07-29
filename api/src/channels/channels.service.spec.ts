/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Jest mock call metadata and asymmetric matchers are typed as any. */
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailVerificationQueueService } from '../queue/email-verification-queue.service';
import { hashEmailVerificationToken } from './email-verification-token';
import { ChannelsService } from './channels.service';

const NOW = new Date('2032-03-04T05:06:07.000Z');

function makeService() {
  const notificationChannel = {
    create: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
  };
  const prisma = {
    project: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'project-1',
        organizationId: 'organization-1',
      }),
    },
    membership: {
      findUnique: jest.fn().mockResolvedValue({ id: 'membership-1' }),
    },
    notificationChannel,
  } as unknown as PrismaService;
  const queue = {
    enqueue: jest.fn().mockResolvedValue(undefined),
  } as unknown as EmailVerificationQueueService;

  return {
    service: new ChannelsService(prisma, queue),
    notificationChannel,
    queue: queue as unknown as { enqueue: jest.Mock },
  };
}

describe('ChannelsService email verification creation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('persists a normalized email channel pending and queues only the raw token', async () => {
    const { service, notificationChannel, queue } = makeService();
    notificationChannel.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'channel-1',
          ...data,
          verificationSentAt: null,
        }),
    );
    notificationChannel.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.create(
      'user-1',
      'project-1',
      'EMAIL',
      JSON.stringify({ email: '  Alerts+Ops@EXAMPLE.COM  ' }),
    );

    const createData = notificationChannel.create.mock.calls[0]?.[0].data as {
      verificationTokenHash: string;
      verificationExpiresAt: Date;
      config: { email: string };
    };
    expect(createData).toEqual(
      expect.objectContaining({
        projectId: 'project-1',
        type: 'EMAIL',
        config: { email: 'Alerts+Ops@example.com' },
        enabled: false,
        verifiedAt: null,
        verificationTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        verificationExpiresAt: new Date('2032-03-05T05:06:07.000Z'),
        verificationSentAt: null,
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith({
      channelId: 'channel-1',
      rawToken: expect.not.stringMatching(/^[a-f0-9]{64}$/),
    });
    const rawToken = queue.enqueue.mock.calls[0]?.[0].rawToken as string;
    expect(hashEmailVerificationToken(rawToken)).toBe(
      createData.verificationTokenHash,
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: 'channel-1',
        organizationId: 'organization-1',
        enabled: false,
        configJson: JSON.stringify({ email: 'Alerts+Ops@example.com' }),
        verificationStatus: 'PENDING',
        verificationExpiresAt: createData.verificationExpiresAt,
        verificationDeliveryStatus: 'SENT',
      }),
    );
  });

  it('returns the persisted pending channel as NOT_SENT when enqueue fails', async () => {
    const { service, notificationChannel, queue } = makeService();
    notificationChannel.create.mockResolvedValue({
      id: 'channel-1',
      projectId: 'project-1',
      type: 'EMAIL',
      config: { email: 'alerts@example.com' },
      enabled: false,
      verifiedAt: null,
      verificationExpiresAt: new Date('2032-03-05T05:06:07.000Z'),
      verificationSentAt: null,
    });
    queue.enqueue.mockRejectedValue(new Error('queue unavailable'));

    await expect(
      service.create(
        'user-1',
        'project-1',
        'EMAIL',
        JSON.stringify({ email: 'alerts@example.com' }),
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        id: 'channel-1',
        verificationStatus: 'PENDING',
        verificationDeliveryStatus: 'NOT_SENT',
      }),
    );
    expect(notificationChannel.updateMany).not.toHaveBeenCalled();
  });

  it('re-reads and returns the current channel when sent acknowledgment loses a token rotation race', async () => {
    const { service, notificationChannel } = makeService();
    notificationChannel.create.mockResolvedValue({
      id: 'channel-1',
      projectId: 'project-1',
      type: 'EMAIL',
      config: { email: 'alerts@example.com' },
      enabled: false,
      verifiedAt: null,
      verificationExpiresAt: new Date('2032-03-05T05:06:07.000Z'),
      verificationSentAt: null,
    });
    notificationChannel.updateMany.mockResolvedValue({ count: 0 });
    notificationChannel.findUnique.mockResolvedValue({
      id: 'channel-1',
      projectId: 'project-1',
      type: 'EMAIL',
      config: { email: 'new-alerts@example.com' },
      enabled: false,
      verifiedAt: null,
      verificationExpiresAt: new Date('2032-03-06T05:06:07.000Z'),
      verificationSentAt: new Date('2032-03-04T05:06:08.000Z'),
    });

    const result = await service.create(
      'user-1',
      'project-1',
      'EMAIL',
      JSON.stringify({ email: 'alerts@example.com' }),
    );

    expect(notificationChannel.findUnique).toHaveBeenCalledWith({
      where: { id: 'channel-1' },
    });
    expect(result).toEqual(
      expect.objectContaining({
        configJson: JSON.stringify({ email: 'new-alerts@example.com' }),
        verificationStatus: 'PENDING',
        verificationExpiresAt: new Date('2032-03-06T05:06:07.000Z'),
        verificationDeliveryStatus: 'SENT',
      }),
    );
  });

  it('explicitly creates non-email channels unverified while preserving enabled behavior', async () => {
    const { service, notificationChannel, queue } = makeService();
    notificationChannel.create.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'channel-2', ...data }),
    );

    const result = await service.create(
      'user-1',
      'project-1',
      'SLACK',
      JSON.stringify({ webhookUrl: 'https://hooks.example.test/secret' }),
    );

    expect(notificationChannel.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'SLACK',
        enabled: true,
        verifiedAt: null,
      }),
    });
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({
        enabled: true,
        verificationStatus: 'NOT_REQUIRED',
        verificationExpiresAt: null,
        verificationDeliveryStatus: 'NOT_REQUIRED',
      }),
    );
  });

  it('derives safe verification fields when listing channels', async () => {
    const { service, notificationChannel } = makeService();
    notificationChannel.findMany.mockResolvedValue([
      {
        id: 'pending',
        projectId: 'project-1',
        type: 'EMAIL',
        config: { email: 'alerts@example.com' },
        enabled: false,
        verifiedAt: null,
        verificationExpiresAt: new Date('2032-03-05T05:06:07.000Z'),
        verificationSentAt: null,
      },
      {
        id: 'verified',
        projectId: 'project-1',
        type: 'EMAIL',
        config: { email: 'ops@example.com' },
        enabled: true,
        verifiedAt: NOW,
        verificationExpiresAt: null,
        verificationSentAt: NOW,
      },
    ]);

    const result = await service.list('user-1', 'project-1');

    expect(result).toEqual([
      expect.objectContaining({
        id: 'pending',
        organizationId: 'organization-1',
        verificationStatus: 'PENDING',
        verificationDeliveryStatus: 'NOT_SENT',
      }),
      expect.objectContaining({
        id: 'verified',
        organizationId: 'organization-1',
        verificationStatus: 'VERIFIED',
        verificationExpiresAt: null,
        verificationDeliveryStatus: 'SENT',
      }),
    ]);
  });

  it('normalizes stored email config and safely hides malformed legacy values', async () => {
    const { service, notificationChannel } = makeService();
    const baseChannel = {
      projectId: 'project-1',
      type: 'EMAIL',
      enabled: true,
      verifiedAt: NOW,
      verificationExpiresAt: null,
      verificationSentAt: null,
    };
    notificationChannel.findMany.mockResolvedValue([
      {
        ...baseChannel,
        id: 'mixed-case',
        config: { email: '  Alerts+Ops@EXAMPLE.COM  ' },
      },
      {
        ...baseChannel,
        id: 'invalid-string',
        config: { email: 'not-an-email' },
      },
      {
        ...baseChannel,
        id: 'non-string',
        config: { email: 42 },
      },
      {
        ...baseChannel,
        id: 'malformed-config',
        config: ['alerts@example.com'],
      },
    ]);

    const result = await service.list('user-1', 'project-1');

    expect(result.map(({ configJson }) => configJson)).toEqual([
      JSON.stringify({ email: 'Alerts+Ops@example.com' }),
      JSON.stringify({ email: '' }),
      JSON.stringify({ email: '' }),
      JSON.stringify({ email: '' }),
    ]);
  });
});
