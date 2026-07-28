import { overallStatus } from "@/lib/status";

/**
 * Returns the public path for a status page given its slug.
 * The slug is percent-encoded so that any URI-unsafe characters are escaped.
 */
export function statusPagePublicPath(slug: string): string {
  return `/status/${encodeURIComponent(slug)}`;
}

export type CheckStatus = "UP" | "DOWN" | "GRACE" | "NEW" | "PAUSED";

export interface PublicCheck {
  name: string;
  status: CheckStatus;
  lastEventAt: string | null;
}

export interface StatusPageData {
  title: string;
  branding: Record<string, unknown> | null;
  checks: PublicCheck[];
}

export function isKnownStatus(s: string): s is CheckStatus {
  return ["UP", "DOWN", "GRACE", "NEW", "PAUSED"].includes(s);
}

/**
 * Fetch a published status page, or null when it does not exist / is
 * unreachable. Shared by the page, its `generateMetadata` and its OG card — the
 * 30s fetch cache collapses all three into a single upstream call.
 */
export async function fetchStatusPage(slug: string): Promise<StatusPageData | null> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8888";

  try {
    const res = await fetch(`${apiUrl}${statusPagePublicPath(slug)}`, {
      next: { revalidate: 30 },
    });
    if (!res.ok) return null;
    return (await res.json()) as StatusPageData;
  } catch {
    return null;
  }
}

export const STATUS_LABEL = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  down: "Major outage",
} as const;

/** Status summary reused across the page title, meta description and OG card. */
export function summarise(data: StatusPageData) {
  const status = overallStatus(data.checks);
  const n = data.checks.length;
  return {
    status,
    label: STATUS_LABEL[status],
    countLabel: `${n} ${n === 1 ? "check" : "checks"} monitored`,
  };
}
