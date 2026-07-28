import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module';
import { ReadinessService } from './health/readiness.service';
import { TelegramBotClient } from './telegram/telegram-bot.client';

export const DEFAULT_HTTP_DRAIN_DELAY_MS = 5_000;
export const DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS = 25_000;
export const SUPPORTED_SHUTDOWN_SIGNALS = [
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
] as const;
export type SupportedShutdownSignal =
  (typeof SUPPORTED_SHUTDOWN_SIGNALS)[number];
const MAX_TIMER_MS = 2_147_483_647;
const TELEGRAM_WEBHOOK_PATH = '/integrations/telegram/webhook';
const telegramWebhookAuthRegistrations = new WeakSet<FastifyInstance>();

export interface LifecycleApplication {
  listen: (options: { port: number; host: string }) => Promise<unknown>;
  close: () => Promise<void>;
}

interface LifecycleReadiness {
  markReady(): void;
}

export type SignalRegistrar = (
  signals: readonly SupportedShutdownSignal[],
  handler: (signal: SupportedShutdownSignal) => void,
) => () => void;

export interface ApplicationLifecycle {
  shutdown(): Promise<void>;
}

export function registerTelegramWebhookAuthentication(
  fastify: FastifyInstance,
  telegramBot: Pick<TelegramBotClient, 'assertWebhookSecret'>,
): void {
  if (telegramWebhookAuthRegistrations.has(fastify)) return;
  telegramWebhookAuthRegistrations.add(fastify);

  fastify.addHook('onRequest', async (request, reply) => {
    if (
      request.method !== 'POST' ||
      (request.url !== TELEGRAM_WEBHOOK_PATH &&
        !request.url.startsWith(`${TELEGRAM_WEBHOOK_PATH}?`))
    ) {
      return;
    }

    const candidate = request.headers['x-telegram-bot-api-secret-token'];
    try {
      telegramBot.assertWebhookSecret(
        typeof candidate === 'string' ? candidate : undefined,
      );
    } catch {
      await reply.code(401).send({
        statusCode: 401,
        message: 'Invalid Telegram webhook',
        error: 'Unauthorized',
      });
    }
  });
}

interface ApplicationLifecycleOptions {
  port: number;
  host?: string;
  drainDelayMs?: number;
  shutdownTimeoutMs?: number;
  registerSignals?: SignalRegistrar;
  forceExit?: (code: number) => void;
}

function registerTerminationSignals(
  signals: readonly SupportedShutdownSignal[],
  handler: (signal: SupportedShutdownSignal) => void,
): () => void {
  const listeners = signals.map((signal) => {
    const listener = () => handler(signal);
    process.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of listeners) {
      process.off(signal, listener);
    }
  };
}

function boundedMilliseconds(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_TIMER_MS);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closeWithDeadline(
  app: LifecycleApplication,
  timeoutMs: number,
): Promise<'closed' | 'failed' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const close = app.close().then(
    () => 'closed' as const,
    () => 'failed' as const,
  );
  const outcome = await Promise.race([close, timeout]);
  if (timer) clearTimeout(timer);
  return outcome;
}

export async function startApplicationLifecycle(
  app: LifecycleApplication,
  readiness: LifecycleReadiness,
  options: ApplicationLifecycleOptions,
): Promise<ApplicationLifecycle> {
  const drainDelayMs = boundedMilliseconds(
    options.drainDelayMs,
    DEFAULT_HTTP_DRAIN_DELAY_MS,
  );
  const shutdownTimeoutMs = boundedMilliseconds(
    options.shutdownTimeoutMs,
    DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS,
  );
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  const registerSignals = options.registerSignals ?? registerTerminationSignals;
  let shutdownStarted = false;
  let shutdownPromise: Promise<void> | undefined;
  let unregisterSignals: () => void = () => undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;

    shutdownStarted = true;
    shutdownPromise = (async () => {
      try {
        await wait(drainDelayMs);
        const outcome = await closeWithDeadline(app, shutdownTimeoutMs);
        if (outcome !== 'closed') {
          forceExit(1);
        }
      } finally {
        unregisterSignals();
      }
    })();
    return shutdownPromise;
  };

  // Native Nest signal hooks would call app.close() outside this deadline.
  // app.close() itself still invokes every Nest shutdown lifecycle hook.
  unregisterSignals = registerSignals(SUPPORTED_SHUTDOWN_SIGNALS, () => {
    void shutdown();
  });

  try {
    await app.listen({
      port: options.port,
      host: options.host ?? '0.0.0.0',
    });
  } catch (error) {
    unregisterSignals();
    throw error;
  }

  if (!shutdownStarted) {
    readiness.markReady();
  }
  return { shutdown };
}

export async function buildApp(): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { rawBody: true },
  );
  // Register helmet on the underlying Fastify instance
  await app.register(helmet, { contentSecurityPolicy: false });
  registerTelegramWebhookAuthentication(
    app.getHttpAdapter().getInstance(),
    app.get(TelegramBotClient),
  );
  app.enableCors({
    origin: process.env.APP_URL ?? 'http://localhost:9999',
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  return app;
}

async function bootstrap() {
  const app = await buildApp();
  const port = Number(process.env.PORT ?? 8888);
  const readiness = app.get(ReadinessService);
  await startApplicationLifecycle(app, readiness, {
    port,
    drainDelayMs: Number(
      process.env.HTTP_DRAIN_DELAY_MS ?? DEFAULT_HTTP_DRAIN_DELAY_MS,
    ),
    shutdownTimeoutMs: Number(
      process.env.HTTP_SHUTDOWN_TIMEOUT_MS ?? DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS,
    ),
  });
}

if (require.main === module) {
  void bootstrap();
}
