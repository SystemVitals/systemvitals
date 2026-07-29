import { Suspense, act } from "react";
import { ApolloClient, ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CheckDetailPage from "@/app/(app)/checks/[id]/page";
import type { Org } from "@/lib/org-context";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
const setActiveOrgId = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

const orgs = [
  {
    id: "org-source",
    name: "Source Org",
    slug: "source",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "creator-source",
    creatorLabel: "source@example.com",
    pingKey: "source",
  },
] satisfies Org[];

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ activeOrg: orgs[0], orgs, setActiveOrgId }),
}));

const check = {
  __typename: "Check",
  id: "check-1",
  organizationId: "org-source",
  notificationChannelIds: [],
  name: "Nightly backup",
  slug: "nightly-backup",
  type: "HEARTBEAT",
  status: "UP",
  pingSlug: null,
  periodSeconds: 300,
  graceSeconds: 60,
  schedule: null,
  tz: null,
  nextExpectedAt: null,
  target: null,
  method: null,
  expectedStatus: null,
  intervalSeconds: null,
  timeoutMs: null,
  events: [],
};

function clientFor(
  result: "success" | "missing" | "error" | "unknown-organization",
  variables: { current?: Record<string, unknown> },
  queryCount: { current: number },
) {
  return new ApolloClient({
    cache: new InMemoryCache(),
    link: new ApolloLink((operation) =>
      new Observable((observer) => {
        if (operation.operationName !== "check") {
          observer.error(new Error(`Unexpected operation: ${operation.operationName}`));
          return;
        }
        variables.current = operation.variables;
        queryCount.current += 1;
        if (result === "error") {
          observer.error(new Error("Check not found"));
          return;
        }
        observer.next({
          data: {
            check:
              result === "missing"
                ? null
                : {
                    ...check,
                    organizationId:
                      result === "unknown-organization"
                        ? "org-inaccessible"
                        : check.organizationId,
                  },
          },
        });
        observer.complete();
      }),
    ),
  });
}

async function renderPage(result: Parameters<typeof clientFor>[0]) {
  const variables: { current?: Record<string, unknown> } = {};
  const queryCount = { current: 0 };

  await act(async () => {
    render(
      <ApolloProvider client={clientFor(result, variables, queryCount)}>
        <Suspense fallback={null}>
          <CheckDetailPage params={Promise.resolve({ id: "check-1" })} />
        </Suspense>
      </ApolloProvider>,
    );
  });

  return { variables, queryCount };
}

describe("legacy check ID route", () => {
  beforeEach(() => {
    navigation.replace.mockClear();
    setActiveOrgId.mockClear();
  });

  it("resolves the organization and replaces the ID route with the canonical slug route", async () => {
    const { variables, queryCount } = await renderPage("success");

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/source/nightly-backup",
      ),
    );
    expect(variables.current).toEqual({ id: "check-1" });
    expect(setActiveOrgId).toHaveBeenCalledWith("org-source");
    expect(setActiveOrgId.mock.invocationCallOrder[0]).toBeLessThan(
      navigation.replace.mock.invocationCallOrder[0],
    );
    expect(queryCount.current).toBe(1);
  });

  it.each(["missing", "error", "unknown-organization"] as const)(
    "does not redirect a %s check lookup",
    async (result) => {
      await renderPage(result);

      await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Error"));
      expect(navigation.replace).not.toHaveBeenCalled();
      expect(setActiveOrgId).not.toHaveBeenCalled();
    },
  );
});
