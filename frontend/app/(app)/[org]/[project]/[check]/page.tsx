"use client";
import { use } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@apollo/client/react";
import { CHECK_BY_SLUG } from "@/lib/queries";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import { usePollWhenVisible } from "@/lib/use-poll-when-visible";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import { useOrg } from "@/lib/org-context";

export default function CheckDetailBySlugPage({
  params,
}: {
  params: Promise<{ org: string; project: string; check: string }>;
}) {
  const { org, project, check } = use(params);
  const router = useRouter();
  const { setActiveOrgId } = useOrg();

  const query = useQuery<{ checkBySlug: CheckDetailData }>(CHECK_BY_SLUG, {
    variables: { orgSlug: org, projectSlug: project, checkSlug: check },
    // Apollo 4 defaults this to true, which would flip `loading` on every poll
    // and flash the skeleton over already-good content every 15s.
    notifyOnNetworkStatusChange: false,
  });
  const { data, loading, error, refetch } = query;

  usePollWhenVisible(query, CHECK_POLL_INTERVAL_MS);

  return (
    <CheckDetail
      check={data?.checkBySlug}
      loading={loading}
      error={error}
      onMoved={(destination) => {
        setActiveOrgId(destination.organizationId);
        router.replace(
          `/${destination.organizationSlug}/${destination.projectSlug}/${destination.checkSlug}`,
        );
      }}
      onRefetch={(updatedCheck) => {
        // A rename-in-place changes the slug this page's query variables are
        // keyed on. Refetching with the now-stale `check` slug would 404
        // (`findBySlug` throws `NotFoundException`) on a page that a moment
        // ago rendered fine, and `usePollWhenVisible` would keep re-hitting
        // that same dead slug every 15s. Navigate to the new canonical URL
        // instead so the page (and its polling) reads the check that now
        // exists. `replace`, not `push` — the old slug URL is dead, it
        // should not be a back-stop in history.
        if (updatedCheck && updatedCheck.slug !== check) {
          router.replace(`/${org}/${project}/${updatedCheck.slug}`);
          return;
        }
        refetch();
      }}
    />
  );
}
