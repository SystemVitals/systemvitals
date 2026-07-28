import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { SITE } from "@/lib/site";
import { Heartbeat } from "@/components/heartbeat";
import { StatusBadge } from "@/components/status-badge";
import { Card, CardContent } from "@/components/ui/card";

const VITALS = [
  { name: "api.acme.io", status: "UP" as const },
  { name: "nightly-backup", status: "GRACE" as const },
  { name: "payments-webhook", status: "DOWN" as const },
];

export function Hero() {
  return (
    <section className="relative overflow-hidden px-4 py-20 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <div className="flex flex-col items-start gap-8 lg:flex-row lg:items-center lg:gap-16">
          {/* Left: copy */}
          <div className="flex flex-col gap-6 lg:flex-1">
            <p className="text-sm font-medium uppercase tracking-widest text-primary">
              Uptime &amp; cron monitoring
            </p>
            <h1 className="font-heading text-4xl font-bold tracking-tight sm:text-6xl">
              {SITE.tagline}
            </h1>
            <p className="max-w-lg text-lg text-muted-foreground">
              Passive heartbeat dead-man&#39;s-switch, active HTTP/TCP/ping probing,
              and multi-channel alerts — so you&#39;re first to know, not last.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/signup" className={buttonVariants({ size: "lg" })}>
                Start free
              </Link>
              <Link
                href="/#how-it-works"
                className={buttonVariants({ variant: "ghost", size: "lg" })}
              >
                How it works
              </Link>
            </div>
          </div>

          {/* Right: EKG + vital-signs card */}
          <div className="w-full lg:flex-1">
            <Heartbeat variant="hero" className="text-primary" />
            <Card className="mt-6">
              <CardContent className="pt-4">
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Vital signs
                </p>
                <ul className="flex flex-col gap-3">
                  {VITALS.map(({ name, status }) => (
                    <li key={name} className="flex items-center justify-between">
                      <span className="font-mono text-sm">{name}</span>
                      <StatusBadge status={status} />
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}
