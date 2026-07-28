import { Suspense, act } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { ApolloClient, ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import type { Org } from "@/lib/org-context";

// See `app/(auth)/login/page.test.tsx` / `app/auth/callback/page.test.tsx` for
// the established pattern of mocking `next/navigation`'s `useRouter`.
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
    projects: [{ id: "project-1", name: "Source", slug: "source", pingKey: "source" }],
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

import CheckDetailBySlugPage from "@/app/(app)/[org]/[project]/[check]/page";

interface CheckRecord {
  __typename: "Check";
  id: string;
  projectId: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  pingSlug: string | null;
  periodSeconds: number | null;
  graceSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  nextExpectedAt: string | null;
  lastEventAt: string | null;
  target: string | null;
  method: string | null;
  expectedStatus: number | null;
  intervalSeconds: number | null;
  timeoutMs: number | null;
  events: unknown[];
}

const INITIAL_CHECK: CheckRecord = {
  __typename: "Check",
  id: "c1",
  projectId: "project-1",
  name: "Nightly job",
  slug: "old-slug",
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
};

/**
 * A link that serves `CheckBySlug` from a mutable ref (so a bare `refetch()`
 * sees whatever `UpdateCheck` last wrote) and applies `UpdateCheck`'s input
 * onto that same ref, mirroring what the real API does. Mirrors the
 * capturing-link pattern in `edit-check-dialog.test.tsx`, extended to cover
 * two operations instead of one.
 */
function makeLink(checkRef: { current: CheckRecord }, queryCount: { current: number }) {
  return new ApolloLink((operation) => {
    return new Observable((observer) => {
      if (operation.operationName === "CheckBySlug") {
        queryCount.current += 1;
        observer.next({ data: { checkBySlug: { ...checkRef.current } } });
        observer.complete();
        return;
      }
      if (operation.operationName === "UpdateCheck") {
        const input = operation.variables.input as Record<string, unknown>;
        checkRef.current = {
          ...checkRef.current,
          name: typeof input.name === "string" ? input.name : checkRef.current.name,
          slug: typeof input.slug === "string" ? input.slug : checkRef.current.slug,
        };
        observer.next({ data: { updateCheck: { ...checkRef.current } } });
        observer.complete();
        return;
      }
      if (operation.operationName === "MoveCheck") {
        observer.next({
          data: {
            moveCheck: {
              id: checkRef.current.id,
              projectId: "project-destination",
              slug: checkRef.current.slug,
            },
          },
        });
        observer.complete();
        return;
      }
      observer.error(new Error(`Unexpected operation: ${operation.operationName}`));
    });
  });
}

async function renderPage() {
  const checkRef = { current: { ...INITIAL_CHECK } };
  const queryCount = { current: 0 };
  const client = new ApolloClient({
    link: makeLink(checkRef, queryCount),
    cache: new InMemoryCache(),
  });

  // The route's `use(params)` needs a Suspense boundary above it — in the
  // real app the Next.js App Router provides one; here it must be supplied
  // explicitly. Unwrapping the params promise happens on a later microtask
  // than the synchronous `render()` call, so the render must be wrapped in
  // an awaited `act` to let that resolution settle before assertions run.
  let utils!: ReturnType<typeof render>;
  await act(async () => {
    utils = render(
      <ApolloProvider client={client}>
        <Suspense fallback={null}>
          <CheckDetailBySlugPage
            params={Promise.resolve({ org: "acme", project: "proj1", check: "old-slug" })}
          />
        </Suspense>
      </ApolloProvider>
    );
  });

  return { ...utils, checkRef, queryCount };
}

// The dialog content is rendered into a Radix portal appended to
// `document.body`, not into the `container` div `render()` returns, so the
// form must be looked up against the document (matches
// `edit-check-dialog.test.tsx`'s `submitForm`).
function submitEditForm() {
  const form = document.querySelector("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

async function moveToDestination() {
  fireEvent.click(screen.getByRole("button", { name: "Move check" }));
  const selects = screen.getAllByRole("combobox");
  fireEvent.click(selects[0]);
  fireEvent.click(await screen.findByRole("option", { name: "Destination Org" }));
  fireEvent.click(selects[1]);
  fireEvent.click(await screen.findByRole("option", { name: "Production" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
  );
}

describe("CheckDetailBySlugPage — rename handling", () => {
  beforeEach(() => {
    replace.mockClear();
    setActiveOrgId.mockClear();
  });

  it("navigates to the new slug URL after an in-place slug rename", async () => {
    await renderPage();
    await screen.findByText("Nightly job");

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/url slug/i), {
      target: { value: "new-slug" },
    });
    submitEditForm();

    await waitFor(() => expect(replace).toHaveBeenCalledWith("/acme/proj1/new-slug"));
  });

  it("does not navigate for a non-slug edit, and refetches in place instead", async () => {
    await renderPage();
    await screen.findByText("Nightly job");

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: "Renamed job" },
    });
    submitEditForm();

    // The refetch (triggered because the slug did not change) picks up the
    // renamed check under the same URL.
    await screen.findByText("Renamed job");
    expect(replace).not.toHaveBeenCalled();
  });

  it("replaces the route with the canonical destination without refetching the source", async () => {
    const { queryCount } = await renderPage();
    await screen.findByText("Nightly job");

    await moveToDestination();

    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/destination/production/old-slug"),
    );
    expect(setActiveOrgId).toHaveBeenCalledWith("org-destination");
    expect(setActiveOrgId.mock.invocationCallOrder[0]).toBeLessThan(
      replace.mock.invocationCallOrder[0],
    );
    expect(queryCount.current).toBe(1);
  });
});
