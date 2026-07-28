"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@apollo/client/react";
import { CHECK } from "@/lib/queries";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import { useOrg } from "@/lib/org-context";

export default function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { setActiveOrgId } = useOrg();

  const query = useQuery<{ check: CheckDetailData }>(CHECK, {
    variables: { id },
    // Apollo 4 defaults this to true, which would flip `loading` on every poll
    // and flash the skeleton over already-good content every 15s.
    notifyOnNetworkStatusChange: false,
  });
  const { data, loading, error, refetch } = query;

  usePollWhenVisible(query, CHECK_POLL_INTERVAL_MS);

  return (
    <CheckDetail
      check={data?.check}
      loading={loading}
      error={error}
      onMoved={(destination) => {
        setActiveOrgId(destination.organizationId);
        router.replace(
          `/${destination.organizationSlug}/${destination.projectSlug}/${destination.checkSlug}`,
        );
      }}
      onRefetch={() => {
        // This route's query is keyed on `id`, which a slug rename never
        // changes, so a plain refetch (ignoring any updated check passed in)
        // is always correct here.
        refetch();
      }}
    />
  );
}
