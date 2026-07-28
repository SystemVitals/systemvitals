import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisConnection, type ConnectionOptions } from 'bullmq';
import { parseRedisUrl } from '../queue/redis-connection';
import { HealthController } from './health.controller';
import { HealthResolver } from './health.resolver';
import {
  PostgresReadinessProbe,
  POSTGRES_READINESS_PROBE,
  READINESS_PROBE_TIMEOUT_MS,
  REDIS_READINESS_CONNECTION,
  REDIS_READINESS_PROBE,
  ReadinessService,
  RedisReadinessProbe,
  type ManagedRedisConnection,
} from './readiness.service';

export function redisReadinessConnectionOptions(
  redisUrl: string,
): ConnectionOptions {
  return {
    ...parseRedisUrl(redisUrl),
    commandTimeout: READINESS_PROBE_TIMEOUT_MS,
    connectTimeout: READINESS_PROBE_TIMEOUT_MS,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  };
}

@Module({
  controllers: [HealthController],
  providers: [
    HealthResolver,
    PostgresReadinessProbe,
    RedisReadinessProbe,
    {
      provide: POSTGRES_READINESS_PROBE,
      useExisting: PostgresReadinessProbe,
    },
    {
      provide: REDIS_READINESS_PROBE,
      useExisting: RedisReadinessProbe,
    },
    ReadinessService,
    {
      provide: REDIS_READINESS_CONNECTION,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ManagedRedisConnection => {
        const redisUrl = config.get<string>(
          'REDIS_URL',
          'redis://localhost:6379',
        );
        const options = redisReadinessConnectionOptions(redisUrl);
        const connection = new RedisConnection(options, {
          blocking: false,
          skipVersionCheck: true,
        });
        connection.on('error', () => undefined);
        return connection;
      },
    },
  ],
  exports: [ReadinessService],
})
export class HealthModule {}
