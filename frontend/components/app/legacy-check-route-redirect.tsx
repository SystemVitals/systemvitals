"use client";

import { permanentRedirect } from "next/navigation";
import { useQuery } from "@apollo/client/react";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import { CHECK_BY_SLUG } from "@/lib/legacy-queries";

interface LegacyCheck extends CheckDetailData {
  projectId: string;
}

interface LegacyCheckRouteRedirectProps {
  orgSlug: string;
  projectSlug: string;
  checkSlug: string;
}

function isCompleteCheck(check: LegacyCheck | null | undefined): check is LegacyCheck {
  return Boolean(
    check?.id &&
      check.organizationId &&
      check.projectId &&
      check.slug,
  );
}

export function LegacyCheckRouteRedirect({
  orgSlug,
  projectSlug,
  checkSlug,
}: LegacyCheckRouteRedirectProps) {
  const { data, loading, error } = useQuery<{
    checkBySlug: LegacyCheck | null;
  }>(CHECK_BY_SLUG, {
    variables: { orgSlug, projectSlug, checkSlug },
    notifyOnNetworkStatusChange: false,
  });
  const check = data?.checkBySlug;

  if (!loading && !error && isCompleteCheck(check)) {
    permanentRedirect(`/${orgSlug}/${check.slug}`);
  }

  const lookupError =
    error ??
    (!loading && data && !isCompleteCheck(check)
      ? new Error("Check not found")
      : undefined);

  return (
    <CheckDetail
      check={undefined}
      loading={loading}
      error={lookupError}
      onMoved={() => undefined}
      onRefetch={() => undefined}
    />
  );
}
