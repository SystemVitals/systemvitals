"use client";

import { use } from "react";
import { LegacyCheckRouteRedirect } from "@/components/app/legacy-check-route-redirect";

export default function LegacyCheckDetailPage({
  params,
}: {
  params: Promise<{ org: string; project: string; check: string }>;
}) {
  const { org, project, check } = use(params);

  return (
    <LegacyCheckRouteRedirect
      orgSlug={org}
      projectSlug={project}
      checkSlug={check}
    />
  );
}
