"use client";

import { use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useApolloClient, useQuery } from "@apollo/client/react";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import { useOrg } from "@/lib/org-context";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import { CHECK_BY_ORGANIZATION_SLUG } from "@/lib/queries";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";

export default function CheckDetailByOrganizationSlugPage({
  params,
}: {
  params: Promise<{ org: string; check: string }>;
}) {
  const { org, check } = use(params);
  const router = useRouter();
  const client = useApolloClient();
  const { activeOrg, setActiveOrgId } = useOrg();
  const query = useQuery<{ checkByOrganizationSlug: CheckDetailData }>(
    CHECK_BY_ORGANIZATION_SLUG,
    {
      variables: { orgSlug: org, checkSlug: check },
      notifyOnNetworkStatusChange: false,
    },
  );
  const { data, loading, error, refetch } = query;
  const resolvedOrganizationId =
    data?.checkByOrganizationSlug.organizationId ?? null;
  const synchronizedOrganizationId = useRef<string | null>(null);

  useEffect(() => {
    if (
      !resolvedOrganizationId ||
      synchronizedOrganizationId.current === resolvedOrganizationId
    ) {
      return;
    }

    synchronizedOrganizationId.current = resolvedOrganizationId;
    if (activeOrg?.id !== resolvedOrganizationId) {
      setActiveOrgId(resolvedOrganizationId);
    }
  }, [activeOrg?.id, resolvedOrganizationId, setActiveOrgId]);

  usePollWhenVisible(query, CHECK_POLL_INTERVAL_MS);

  return (
    <CheckDetail
      check={data?.checkByOrganizationSlug}
      loading={loading}
      error={error}
      onMoved={(destination) => {
        setActiveOrgId(destination.organizationId);
        router.replace(
          `/${destination.organizationSlug}/${destination.checkSlug}`,
        );
      }}
      onRefetch={(updatedCheck) => {
        if (updatedCheck && updatedCheck.slug !== check) {
          try {
            client.cache.evict({
              id: "ROOT_QUERY",
              fieldName: "checkByOrganizationSlug",
              args: { orgSlug: org, checkSlug: check },
            });
            client.cache.gc();
          } catch {
            // The rename is committed; cache cleanup must not block navigation.
          }
          router.replace(`/${org}/${updatedCheck.slug}`);
          return;
        }
        refetch();
      }}
    />
  );
}
