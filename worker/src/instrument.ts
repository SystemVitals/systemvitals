import "dotenv/config";
import * as Sentry from "@sentry/node";

if (process.env.SENTRY_DSN && process.env.NODE_ENV !== "test") {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    enableLogs: false,
    integrations: [Sentry.onUnhandledRejectionIntegration({ mode: "strict" })],
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.breadcrumbs;
      delete event.extra;
      delete event.message;
      for (const exception of event.exception?.values || []) {
        exception.value = "Application operation failed";
      }
      return event;
    },
  });
}

export function captureWorkerError(error: unknown, queue?: string): void {
  if (!process.env.SENTRY_DSN || process.env.NODE_ENV === "test") return;
  Sentry.captureException(error, { tags: { ...(queue ? { queue } : {}) } });
}

export async function flushSentry(): Promise<void> {
  await Sentry.flush(2000);
}
