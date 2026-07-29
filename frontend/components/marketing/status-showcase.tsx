import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/status-badge";

// 30-day uptime strip — true = healthy, false = incident
function buildStrip(total: number, outages: number[]): boolean[] {
  const strip = Array.from({ length: total }, () => true);
  for (const i of outages) {
    if (i >= 0 && i < total) strip[i] = false;
  }
  return strip;
}

// Uptime percentages reflect a 90-day monitoring window; the visual strip shows
// the most recent 30 days. 1 incident segment in the 30-day strip is consistent
// with ~99% uptime over the broader 90-day history.
const SERVICES = [
  {
    name: "API",
    strip: buildStrip(30, [22]),
    uptime: "99.7%",
  },
  {
    name: "Database",
    strip: buildStrip(30, []),
    uptime: "100%",
  },
  {
    name: "CDN",
    strip: buildStrip(30, [7]),
    uptime: "99.4%",
  },
  {
    name: "Webhooks",
    strip: buildStrip(30, [14]),
    uptime: "99.5%",
  },
] as const;

export function StatusShowcase() {
  return (
    <section
      id="status-pages"
      className="border-t border-border px-4 py-20 sm:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-12 text-center">
          <p className="mb-2 text-sm font-medium uppercase tracking-widest text-primary">
            Public transparency
          </p>
          <h2 className="font-heading text-3xl font-bold tracking-tight sm:text-4xl">
            Your status page, ready to share
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Every organization gets a public status page with live uptime
            history and incident reports — no extra setup required.
          </p>
        </div>

        {/* Browser-chrome mock */}
        <div className="mx-auto max-w-2xl">
          <Card className="overflow-hidden border-border/60">
            {/* Browser chrome bar */}
            <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
              <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
              <div className="mx-auto rounded bg-background px-4 py-0.5 text-xs text-muted-foreground">
                status.acme.com
              </div>
            </div>

            <CardContent className="p-6">
              {/* Status page header */}
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <p className="font-heading text-lg font-bold">Acme Platform</p>
                  <p className="text-sm text-muted-foreground">
                    All systems operational
                  </p>
                </div>
                <StatusBadge status="UP" />
              </div>

              {/* Service rows */}
              <div className="flex flex-col gap-4">
                {SERVICES.map((svc) => (
                  <div key={svc.name}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="font-medium">{svc.name}</span>
                      <span className="text-muted-foreground">{svc.uptime}</span>
                    </div>
                    {/* 30-day uptime strip */}
                    <div className="flex gap-0.5">
                      {svc.strip.map((healthy, i) => (
                        <div
                          key={i}
                          className={`h-6 flex-1 rounded-sm ${
                            healthy ? "bg-success" : "bg-destructive"
                          }`}
                          title={healthy ? "Operational" : "Incident"}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Resolved incident */}
              <div className="mt-6 rounded-lg border border-border/60 bg-muted/30 px-4 py-3">
                <p className="text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">Jun 14</span>
                  {" "}— API latency spike ·{" "}
                  <span className="text-success font-medium">
                    Resolved in 23 min
                  </span>
                </p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </section>
  );
}
