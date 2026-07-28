import {
  HeartPulse,
  Radar,
  Bell,
  AlarmClock,
  PanelTop,
  TerminalSquare,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

const FEATURES = [
  {
    Icon: HeartPulse,
    title: "Heartbeat dead-man's-switch",
    body: "Drop a ping URL in your cron. We page you when the beat stops.",
  },
  {
    Icon: Radar,
    title: "Active probing",
    body: "HTTP, TCP, and ping checks from our workers on your schedule.",
  },
  {
    Icon: Bell,
    title: "Multi-channel alerting",
    body: "Email, Slack, Telegram, and webhooks — wherever your team looks.",
  },
  {
    Icon: AlarmClock,
    title: "Escalation policies",
    body: "Multi-step, delay-based escalation with reminders until acknowledged.",
  },
  {
    Icon: PanelTop,
    title: "Public status pages",
    body: "Branded, per-project status pages with incident history.",
  },
  {
    Icon: TerminalSquare,
    title: "API + MCP server",
    body: "Manage everything over GraphQL — or straight from Claude Code.",
  },
] as const;

export function FeatureGrid() {
  return (
    <section id="features" className="px-4 py-20 sm:py-28">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">
            Everything you need
          </p>
          <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
            Built for production reliability
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            One platform for heartbeat monitoring, active probing, smart
            alerting, and public transparency.
          </p>
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ Icon, title, body }) => (
            <Card key={title} className="border-border/60">
              <CardContent className="flex flex-col gap-4 pt-6">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{body}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}
