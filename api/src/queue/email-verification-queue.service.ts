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
    };
  }

  private getQueue(): Queue<EmailVerificationJobData> {
    this.queue ??= new Queue<EmailVerificationJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: EMAIL_VERIFICATION_JOB_OPTIONS,
      skipWaitingForReady: true,
    });
    return this.queue;
  }

  async enqueue(data: EmailVerificationJobData): Promise<void> {
    await this.getQueue().add('email-verification', data);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
  }
}
