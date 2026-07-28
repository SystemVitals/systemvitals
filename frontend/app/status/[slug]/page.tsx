import type { Metadata } from "next";
import Link from "next/link";
import { StatusBadge } from "@/components/status-badge";
import { Wordmark } from "@/components/brand/wordmark";
import { cn } from "@/lib/utils";
import { overallStatus } from "@/lib/status";
import { SITE } from "@/lib/site";
import {
  fetchStatusPage,
  isKnownStatus,
  statusPagePublicPath,
  summarise,
} from "@/lib/status-page";

function formatTimestamp(ts: string | null): string {
  if (!ts) return "No events yet";
  try {
    return new Date(ts).toLocaleString("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return ts;
  }
}

function OverallStatusDot({ status }: { status: "operational" | "degraded" | "down" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block h-3 w-3 rounded-full shrink-0",
        status === "operational" && "bg-success",
        status === "degraded" && "bg-warning",
        status === "down" && "bg-destructive"
      )}
    />
  );
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await fetchStatusPage(slug);
  const url = statusPagePublicPath(slug);

  // Unknown slug: keep it out of the index rather than publishing a card for a
  // page that does not exist.
  if (!data) {
    return {
      title: "Status page not found",
      description: `No status page is published at ${url}.`,
      robots: { index: false, follow: false },
    };
  }

  const { label, countLabel } = summarise(data);
  const title = `${data.title} status`;
  const description = `${label} — ${countLabel}. Live uptime and incident history for ${data.title}, powered by ${SITE.name}.`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      locale: "en_US",
      url,
      title,
      description,
    },
    twitter: { card: "summary_large_image", title, description },
    robots: { index: true, follow: true },
  };
}

export default async function PublicStatusPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await fetchStatusPage(slug);

  if (!data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center space-y-3">
          <Wordmark className="mx-auto justify-center text-muted-foreground" />
          <div className="space-y-1 pt-2">
            <h1 className="font-heading text-2xl font-semibold text-foreground">
              Status page not found
            </h1>
            <p className="text-muted-foreground text-sm">
              The status page{" "}
              <code className="font-mono text-foreground/70 bg-muted px-1.5 py-0.5 rounded text-xs">
                {slug}
              </code>{" "}
              does not exist or has been removed.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const status = overallStatus(data.checks);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border bg-card">
        <div className="max-w-3xl mx-auto px-4 py-5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <OverallStatusDot status={status} />
            <div className="min-w-0">
              <h1 className="font-heading text-xl font-semibold text-foreground truncate">
                {data.title}
              </h1>
              <p
                className={cn(
                  "text-sm font-medium mt-0.5",
                  status === "operational" && "text-success",
                  status === "degraded" && "text-warning",
                  status === "down" && "text-destructive"
                )}
              >
                {status === "operational"
                  ? "All systems operational"
                  : status === "degraded"
                    ? "Partial degradation — one or more systems in a grace period"
                    : "One or more systems are affected"}
              </p>
            </div>
          </div>
          <Wordmark
            className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            href="/"
          />
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-8 space-y-6">
        {data.checks.length === 0 ? (
          <div className="bg-card border border-border rounded-xl px-6 py-8 text-center">
            <p className="text-sm text-muted-foreground">
              No checks on this status page.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl divide-y divide-border overflow-hidden">
            {data.checks.map((check, idx) => {
              const status = isKnownStatus(check.status)
                ? check.status
                : "NEW";
              const ts = formatTimestamp(check.lastEventAt);
              return (
                <div
                  key={idx}
                  className="flex items-center gap-4 px-5 py-3.5 hover:bg-muted/40 transition-colors"
                >
                  <span className="flex-1 font-medium text-sm text-foreground font-heading truncate">
                    {check.name}
                  </span>
                  <time
                    className="text-xs text-muted-foreground font-mono shrink-0 hidden sm:block"
                    dateTime={check.lastEventAt ?? undefined}
                    title={ts}
                  >
                    {ts}
                  </time>
                  <StatusBadge status={status} />
                </div>
              );
            })}
          </div>
        )}

        {/* Info card */}
        <div className="bg-card border border-border rounded-xl px-5 py-4 text-xs text-muted-foreground space-y-1">
          <p>
            Status data is cached for up to{" "}
            <span className="font-mono font-medium text-foreground">30s</span>.
          </p>
          <p>
            Page slug:{" "}
            <code className="font-mono text-foreground/70 bg-muted px-1.5 py-0.5 rounded">
              {slug}
            </code>
          </p>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <span>Powered by</span>
          <Link
            href="/"
            className="font-heading font-medium text-primary hover:text-primary/80 transition-colors"
          >
            SystemVitals
          </Link>
        </div>
      </footer>
    </div>
  );
}
