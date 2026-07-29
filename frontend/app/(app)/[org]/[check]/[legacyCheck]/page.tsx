"use client";

import { use } from "react";
import { LegacyCheckRouteRedirect } from "@/components/app/legacy-check-route-redirect";

export default function LegacyCheckDetailPage({
  params,
}: {
  params: Promise<{ org: string; check: string; legacyCheck: string }>;
}) {
  const { org, check, legacyCheck } = use(params);

  return (
    <LegacyCheckRouteRedirect
      orgSlug={org}
      projectSlug={check}
      checkSlug={legacyCheck}
    />
  );
}
