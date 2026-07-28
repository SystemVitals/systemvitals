import { Suspense, act } from "react";
import { ApolloClient, ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Org } from "@/lib/org-context";

const replace = vi.fn();
const setActiveOrgId = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
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
    projects: [{ id: "project-source", name: "Source", slug: "source", pingKey: "source" }],
  },
  {
    id: "org-destination",
    name: "Destination Org",
    slug: "destination",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "creator-destination",
    creatorLabel: "destination@example.com",
    projects: [
      {
        id: "project-destination",
        name: "Production",
        slug: "production",
        pingKey: "production",
      },
    ],
  },
] satisfies Org[];

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ activeOrg: orgs[0], orgs, setActiveOrgId }),
}));

import CheckDetailPage from "@/app/(app)/checks/[id]/page";

function makeLink(queryCount: { current: number }) {
  return new ApolloLink((operation) =>
    new Observable((observer) => {
      if (operation.operationName === "check") {
        queryCount.current += 1;
        observer.next({
          data: {
            check: {
              __typename: "Check",
              id: "check-1",
              projectId: "project-source",
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
              lastEventAt: null,
              target: null,
              method: null,
              expectedStatus: null,
              intervalSeconds: null,
              timeoutMs: null,
              events: [],
            },
          },
        });
        observer.complete();
        return;
      }
      if (operation.operationName === "MoveCheck") {
        observer.next({
          data: {
            moveCheck: {
              id: "check-1",
              projectId: "project-destination",
              slug: "nightly-backup",
            },
          },
        });
        observer.complete();
        return;
      }
      observer.error(new Error(`Unexpected operation: ${operation.operationName}`));
    }),
  );
}

describe("CheckDetailPage — move handling", () => {
  beforeEach(() => {
    replace.mockClear();
    setActiveOrgId.mockClear();
  });

  it("replaces the ID route with the canonical destination without refetching it", async () => {
    const queryCount = { current: 0 };
    const client = new ApolloClient({
      link: makeLink(queryCount),
      cache: new InMemoryCache(),
    });

    await act(async () => {
      render(
        <ApolloProvider client={client}>
          <Suspense fallback={null}>
            <CheckDetailPage params={Promise.resolve({ id: "check-1" })} />
          </Suspense>
        </ApolloProvider>,
      );
    });
    await screen.findByText("Nightly backup");

    fireEvent.click(screen.getByRole("button", { name: "Move check" }));
    const selects = screen.getAllByRole("combobox");
    fireEvent.click(selects[0]);
    fireEvent.click(await screen.findByRole("option", { name: "Destination Org" }));
    fireEvent.click(selects[1]);
    fireEvent.click(await screen.findByRole("option", { name: "Production" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
    );

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith(
        "/destination/production/nightly-backup",
      ),
    );
    expect(setActiveOrgId).toHaveBeenCalledWith("org-destination");
    expect(setActiveOrgId.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0],
    );
    expect(queryCount.current).toBe(1);
  });
});
