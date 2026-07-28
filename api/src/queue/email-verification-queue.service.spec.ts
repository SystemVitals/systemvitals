import { ConfigModule, ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { parseRedisUrl } from './redis-connection';
import {
  EmailVerificationQueueService,
  type EmailVerificationJobData,
} from './email-verification-queue.service';
import { QueueModule } from './queue.module';
import { Test } from '@nestjs/testing';

jest.mock('bullmq', () => ({
  Queue: jest.fn(),
}));

const QueueMock = Queue as jest.MockedClass<typeof Queue>;
const RealBullMq = jest.requireActual<typeof import('bullmq')>('bullmq');

function createRealQueue(
  name: string,
  options: ConstructorParameters<typeof RealBullMq.Queue>[1],
) {
  const queue = new RealBullMq.Queue(name, options);
  queue.on('error', () => undefined);
  return queue;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for Redis queue lifecycle');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('EmailVerificationQueueService', () => {
  let add: jest.Mock;
  let close: jest.Mock;

  beforeEach(() => {
    add = jest.fn().mockResolvedValue(undefined);
    close = jest.fn().mockResolvedValue(undefined);
    QueueMock.mockImplementation(
      () =>
        ({
          add,
          close,
        }) as unknown as Queue,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('lazily enqueues the raw token with fail-fast connection and immediate removal defaults', async () => {
    const config = new ConfigService({
      REDIS_URL: 'redis://:secret@redis.example.test:6380/2',
      QUEUE_EMAIL_VERIFICATION: 'verification-delivery',
    });
    const service = new EmailVerificationQueueService(config);

    expect(QueueMock).not.toHaveBeenCalled();

    await service.enqueue({
      channelId: 'channel_123',
      rawToken: 'opaque-token',
    });

    expect(QueueMock).toHaveBeenCalledWith('verification-delivery', {
      connection: {
        host: 'redis.example.test',
        port: 6380,
        password: 'secret',
        db: 2,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1000,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
      skipWaitingForReady: true,
    });
    expect(add).toHaveBeenCalledWith('email-verification', {
      channelId: 'channel_123',
      rawToken: 'opaque-token',
    });
  });

  it('uses the default queue name when no name is configured', async () => {
    const service = new EmailVerificationQueueService(new ConfigService());

    await service.enqueue({
      channelId: 'channel_123',
      rawToken: 'opaque-token',
    });

    expect(QueueMock).toHaveBeenCalledWith(
      'email-verification',
      expect.any(Object),
    );
  });

  it('closes a constructed queue on module teardown', async () => {
    const service = new EmailVerificationQueueService(new ConfigService());

    await service.enqueue({
      channelId: 'channel_123',
      rawToken: 'opaque-token',
    });
    await service.onModuleDestroy();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not construct a queue solely to tear it down', async () => {
    const service = new EmailVerificationQueueService(new ConfigService());

    await service.onModuleDestroy();

    expect(QueueMock).not.toHaveBeenCalled();
  });
});

describe('EmailVerificationQueueService Redis lifecycle', () => {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const queueName = `email-verification-test-${process.pid}-${Date.now()}`;
  let redisAvailable = false;

  beforeAll(async () => {
    const probe = createRealQueue(`${queueName}-probe`, {
      connection: {
        ...parseRedisUrl(redisUrl),
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        connectTimeout: 1000,
      },
      skipWaitingForReady: true,
    });

    try {
      await probe.waitUntilReady();
      redisAvailable = true;
      await probe.obliterate({ force: true });
    } catch {
      redisAvailable = false;
    } finally {
      await probe.close();
    }
  }, 5000);

  it('removes completed and terminally failed raw-token payloads when local Redis is available', async () => {
    if (!redisAvailable) return;

    QueueMock.mockImplementation((name, options) =>
      createRealQueue(name, options),
    );
    const observer = createRealQueue(queueName, {
      connection: parseRedisUrl(redisUrl),
    });
    const successfulToken = 'raw-token-success';
    const failedToken = 'raw-token-failure';
    let successfulDelivery = false;
    let failedDelivery = false;
    const worker = new RealBullMq.Worker<EmailVerificationJobData>(
      queueName,
      (job) => {
        if (job.data.rawToken === failedToken) {
          failedDelivery = true;
          job.discard();
          return Promise.reject(new Error('synthetic terminal failure'));
        }
        successfulDelivery = job.data.rawToken === successfulToken;
        return Promise.resolve();
      },
      { connection: parseRedisUrl(redisUrl) },
    );
    const service = new EmailVerificationQueueService(
      new ConfigService({
        REDIS_URL: redisUrl,
        QUEUE_EMAIL_VERIFICATION: queueName,
      }),
    );

    try {
      await worker.waitUntilReady();
      await service.enqueue({
        channelId: 'channel_success',
        rawToken: successfulToken,
      });
      await service.enqueue({
        channelId: 'channel_failure',
        rawToken: failedToken,
      });

      await waitFor(() => successfulDelivery && failedDelivery);
      await waitFor(async () => {
        const jobs = await observer.getJobs([
          'wait',
          'active',
          'delayed',
          'prioritized',
          'completed',
          'failed',
        ]);
        return jobs.length === 0;
      });

      const retainedJobs = await observer.getJobs([
        'wait',
        'active',
        'delayed',
        'prioritized',
        'completed',
        'failed',
      ]);
      expect(JSON.stringify(retainedJobs)).not.toContain(successfulToken);
      expect(JSON.stringify(retainedJobs)).not.toContain(failedToken);
    } finally {
      await service.onModuleDestroy();
      await worker.close();
      await observer.obliterate({ force: true });
      await observer.close();
    }
  }, 15_000);

  it('rejects a Redis outage in bounded time', async () => {
    QueueMock.mockImplementation((name, options) =>
      createRealQueue(name, options),
    );
    const service = new EmailVerificationQueueService(
      new ConfigService({
        REDIS_URL: 'redis://127.0.0.1:1',
        QUEUE_EMAIL_VERIFICATION: `${queueName}-outage`,
      }),
    );

    try {
      let timeout: NodeJS.Timeout | undefined;
      try {
        await expect(
          Promise.race([
            service.enqueue({
              channelId: 'channel_outage',
              rawToken: 'raw-token-outage',
            }),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Queue producer did not fail in time')),
                3000,
              );
            }),
          ]),
        ).rejects.toThrow();
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    } finally {
      await service.onModuleDestroy();
    }
  }, 5000);
});

describe('QueueModule', () => {
  it('makes the email-verification queue available to importing modules', async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), QueueModule],
    }).compile();

    expect(module.get(EmailVerificationQueueService)).toBeInstanceOf(
      EmailVerificationQueueService,
    );

    await module.close();
  });
});
