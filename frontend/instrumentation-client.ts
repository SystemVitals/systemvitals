import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN) && process.env.NODE_ENV !== "test",
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
  sendDefaultPii: false,
  tracesSampleRate: 0,
  enableLogs: false,
  beforeSend(event) {
    delete event.request;
    delete event.user;
    delete event.breadcrumbs;
    return event;
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
