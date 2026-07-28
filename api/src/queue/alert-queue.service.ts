import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  DEFAULT_JOB_OPTIONS,
  parseRedisUrl,
  type RedisConnectionOptions,
} from './redis-connection';

export interface AlertJobData {
  checkId: string;
  kind: 'down' | 'recovery';
}

@Injectable()
export class AlertQueueService implements OnModuleDestroy {
  private readonly queueName: string;
  private readonly connection: RedisConnectionOptions;
  private queue?: Queue<AlertJobData>;

  constructor(private readonly config: ConfigService) {
    const redisUrl = this.config.get<string>(
      'REDIS_URL',
      'redis://localhost:6379',
    );
    this.queueName = this.config.get<string>('QUEUE_ALERT', 'alert');
    this.connection = parseRedisUrl(redisUrl);
  }

  private getQueue(): Queue<AlertJobData> {
    this.queue ??= new Queue<AlertJobData>(this.queueName, {
      connection: this.connection,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    return this.queue;
  }

  async enqueue(data: AlertJobData): Promise<void> {
    await this.getQueue().add('alert', data);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.queue) await this.queue.close();
  }
}
