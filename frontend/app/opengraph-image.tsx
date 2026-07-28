import { OG_CONTENT_TYPE, OG_SIZE, renderOgCard } from "@/lib/og";
import { SITE } from "@/lib/site";

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

export default async function Image() {
  return renderOgCard({
    title: "Know the moment your systems",
    titleAccent: "flatline.",
    subtitle:
      "Heartbeat dead-man's-switch plus active HTTP, TCP and ping probing — with multi-channel alerting, escalation policies and public status pages.",
    pill: { label: "All systems operational", tone: "up" },
  });
}
