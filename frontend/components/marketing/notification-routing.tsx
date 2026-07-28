import { Check, Mail, Send, Webhook } from "lucide-react";

const ROUTES = [
  {
    name: "Email",
    detail: "on-call@acme.dev",
    Icon: Mail,
  },
  {
    name: "Telegram",
    detail: "Production alerts",
    Icon: Send,
  },
  {
    name: "Webhook",
    detail: "incident automation",
    Icon: Webhook,
  },
] as const;

export function NotificationRouting() {
  return (
    <section
      aria-label="Per-check notification routing"
      className="border-t border-border px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(24rem,1.15fr)] lg:items-center lg:gap-16">
          <div>
            <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">
              Per-check notification routing
            </p>
            <h2
              id="notification-routing-heading"
              className="font-heading text-3xl font-bold tracking-tight sm:text-4xl"
            >
              Route each check to the right channels
            </h2>
            <p className="mt-4 text-muted-foreground">
              Select exactly where each check should notify. The same routes
              receive DOWN and recovery events, without a policy editor to
              maintain.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              Recovery is sent only when a DOWN check returns UP.
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/30 px-5 py-4">
              <div>
                <p className="font-heading font-semibold">Database API</p>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                  HTTP · every 30s
                </p>
              </div>
              <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 font-mono text-[11px] font-semibold tracking-wide text-primary">
                DOWN + RECOVERY
              </span>
            </div>

            <div className="px-5 py-4">
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
                Selected channels
              </p>
              <ul className="divide-y divide-border" aria-label="Selected notification channels">
                {ROUTES.map(({ name, detail, Icon }) => (
                  <li
                    key={name}
                    aria-label={name}
                    className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                      <Icon className="size-4 text-primary" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {detail}
                      </span>
                    </span>
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-primary text-primary-foreground">
                      <Check className="size-3.5" aria-hidden="true" />
                      <span className="sr-only">Selected</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
