import * as Sentry from '@sentry/nestjs';

// Load local configuration before Nest's ConfigModule and instrumentation.
try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

if (process.env.SENTRY_DSN && process.env.NODE_ENV !== 'test') {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    enableLogs: false,
    integrations: [Sentry.onUnhandledRejectionIntegration({ mode: 'strict' })],
    beforeSend(event) {
      // Monitoring endpoints can carry bearer credentials and notification data.
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.message;
      for (const exception of event.exception?.values || []) {
        exception.value = 'Application operation failed';
      }
      return event;
    },
  });
}

export function captureServerError(error: unknown): void {
  if (process.env.SENTRY_DSN && process.env.NODE_ENV !== 'test') {
    Sentry.captureException(error);
  }
}

export async function flushSentry(): Promise<void> {
  await Sentry.flush(2000);
}
