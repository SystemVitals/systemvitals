import { OG_CONTENT_TYPE, OG_SIZE, renderOgCard, type OgTone } from "@/lib/og";
import { SITE } from "@/lib/site";
import { fetchStatusPage, summarise } from "@/lib/status-page";

export const alt = `Live status page — ${SITE.name}`;
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const TONE: Record<"operational" | "degraded" | "down", OgTone> = {
  operational: "up",
  degraded: "degraded",
  down: "down",
};

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await fetchStatusPage(slug);

  if (!data) {
    return renderOgCard({
      title: "Status page not found",
      subtitle: `No status page is published at /status/${slug}.`,
      pill: { label: "Unavailable", tone: "down" },
    });
  }

  const { status, label, countLabel } = summarise(data);

  return renderOgCard({
    title: data.title,
    subtitle: `${countLabel} · Live uptime and incident history, powered by ${SITE.name}.`,
    pill: { label, tone: TONE[status] },
  });
}
