import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, type RedisOptions } from 'bullmq';
import { parseRedisUrl } from './redis-connection';

export interface EmailVerificationJobData {
  channelId: string;
  rawToken: string;
}

const EMAIL_VERIFICATION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: true,
  removeOnFail: true,
};

@Injectable()
export class EmailVerificationQueueService implements OnModuleDestroy {
  private readonly queueName: string;
  private readonly connection: RedisOptions;
  private queue?: Queue<EmailVerificationJobData>;

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
    this.queueName = this.config.get<string>(
      'QUEUE_EMAIL_VERIFICATION',
      'email-verification',
    );
    this.connection = {
      ...parseRedisUrl(redisUrl),
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 1000,
      // Never reconnect in the background: a failed connection ends quickly, so
      // readiness waits stay bounded during an outage. `enqueue` reconnects instead.
      retryStrategy: () => null,
    };
  }

  private getQueue(): Queue<EmailVerificationJobData> {
    // BullMQ must wait for the socket before its first command: with the offline queue
    // disabled, skipping that wait made every enqueue fail. Readiness still fails fast.
    this.queue ??= new Queue<EmailVerificationJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: EMAIL_VERIFICATION_JOB_OPTIONS,
    });
    return this.queue;
  }

  async enqueue(data: EmailVerificationJobData): Promise<void> {
    // A failed or dropped connection is never reused; retry once on a fresh one, which
    // covers a Redis restart after the cached connection was established.
    for (let attempt = 1; ; attempt++) {
      const queue = this.getQueue();
      try {
        await queue.add('email-verification', data);
        return;
      } catch (error) {
        if (this.queue === queue) this.queue = undefined;
        await queue.close().catch(() => undefined);
        if (attempt >= 2) throw error;
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
  }
}
