import { Hash, Mail, Send, Webhook } from "lucide-react";
import { cn } from "@/lib/utils";

const STEPS = [
  {
    delay: "0 min",
    label: "Slack #ops",
    icons: [Hash],
  },
  {
    delay: "5 min",
    label: "Email on-call",
    icons: [Mail],
  },
  {
    delay: "15 min",
    label: "Telegram + Webhook (PagerDuty)",
    icons: [Send, Webhook],
  },
] as const;

export function Escalation() {
  return (
    <section
      id="escalation"
      className="border-t border-border px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
          {/* Left: copy */}
          <div>
            <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">
              Policy-driven response
            </p>
            <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
              Escalate until someone answers
            </h2>
            <p className="mt-4 text-muted-foreground">
              Define multi-step escalation policies that keep trying new channels
              until an alert is acknowledged. No more single points of
              notification failure — if Slack is missed, email follows; if email
              is missed, Telegram and your webhook fire. The cycle repeats on
              your reminder interval until a human responds.
            </p>
          </div>

          {/* Right: vertical timeline */}
          <div className="flex flex-col gap-0">
            {STEPS.map((step, idx) => {
              const isLast = idx === STEPS.length - 1;
              return (
                <div key={step.delay} className="flex gap-4">
                  {/* Connector column */}
                  <div className="flex flex-col items-center">
                    <div className={cn(
                      "flex shrink-0 items-center justify-center rounded-full bg-primary/10 ring-1 ring-primary/20",
                      step.icons.length > 1 ? "h-9 w-14 gap-1" : "h-9 w-9"
                    )}>
                      {step.icons.map((Icon, i) => (
                        <Icon key={i} className="h-4 w-4 text-primary" />
                      ))}
                    </div>
                    {!isLast && (
                      <div className="my-1 w-px flex-1 bg-border" />
                    )}
                  </div>

                  {/* Row content */}
                  <div className={`flex items-center gap-3 ${isLast ? "pb-0" : "pb-6"}`}>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {step.delay}
                    </span>
                    <span className="text-sm font-medium">{step.label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
