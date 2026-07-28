import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  DEFAULT_JOB_OPTIONS,
  parseRedisUrl,
  type RedisConnectionOptions,
} from './redis-connection';

export interface InviteJobData {
  inviteId: string;
}

@Injectable()
export class InviteQueueService implements OnModuleDestroy {
  private readonly queueName: string;
  private readonly connection: RedisConnectionOptions;
  private queue?: Queue<InviteJobData>;

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
    this.queueName = this.config.get<string>('QUEUE_INVITE', 'invite');
    this.connection = parseRedisUrl(redisUrl);
  }

  private getQueue(): Queue<InviteJobData> {
    this.queue ??= new Queue<InviteJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    return this.queue;
  }

  async enqueue(data: InviteJobData): Promise<void> {
    await this.getQueue().add('invite', data);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
  }
}
