"use client";

import { use, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@apollo/client/react";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import { useOrg } from "@/lib/org-context";
import { CHECK } from "@/lib/queries";

export default function CheckDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const { orgs, setActiveOrgId } = useOrg();
  const { data, loading, error } = useQuery<{
    check: CheckDetailData | null;
  }>(CHECK, {
    variables: { id },
    notifyOnNetworkStatusChange: false,
  });
  const check = data?.check;
  const organization = check
    ? orgs.find((org) => org.id === check.organizationId)
    : undefined;
  const canRedirect = !loading && !error && Boolean(check && organization);

  useEffect(() => {
    if (canRedirect && check && organization) {
      setActiveOrgId(organization.id);
      router.replace(`/${organization.slug}/${check.slug}`);
    }
  }, [canRedirect, check, organization, router, setActiveOrgId]);

  if (canRedirect) return null;

  const lookupError =
    error ??
    (!loading && data && !check
      ? new Error("Check not found")
      : !loading && check && !organization
        ? new Error("Check organization not found")
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
