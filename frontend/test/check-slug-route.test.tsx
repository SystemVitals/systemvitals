import { Suspense, act } from "react";
import { ApolloClient, ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { print } from "graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CanonicalCheckPage from "@/app/(app)/[org]/[check]/page";
import LegacyCheckPage from "@/app/(app)/[org]/[project]/[check]/page";
import type { Org } from "@/lib/org-context";
import { CHECK_BY_ORGANIZATION_SLUG } from "@/lib/queries";

const navigation = vi.hoisted(() => ({
  permanentRedirect: vi.fn(),
  replace: vi.fn(),
}));
const setActiveOrgId = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  permanentRedirect: navigation.permanentRedirect,
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
  {
    id: "org-destination",
    name: "Destination Org",
    slug: "destination",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "creator-destination",
    creatorLabel: "destination@example.com",
    pingKey: "destination",
  },
] satisfies Org[];

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ activeOrg: orgs[0], orgs, setActiveOrgId }),
}));

interface CheckRecord {
  __typename: "Check";
  id: string;
  organizationId: string;
  notificationChannelIds: string[];
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
  organizationId: "org-source",
  notificationChannelIds: ["email"],
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

function makeCanonicalLink(
  checkRef: { current: CheckRecord },
  queryCount: { current: number },
  variables: { current?: Record<string, unknown> },
  options?: { rejectCanonicalLookup?: boolean },
) {
  return new ApolloLink((operation) =>
    new Observable((observer) => {
      if (operation.operationName === "CheckByOrganizationSlug") {
        queryCount.current += 1;
        variables.current = operation.variables;
        if (options?.rejectCanonicalLookup) {
          observer.error(new Error("Check not found"));
          return;
        }
        observer.next({
          data: { checkByOrganizationSlug: { ...checkRef.current } },
        });
        observer.complete();
        return;
      }
      if (operation.operationName === "channels") {
        observer.next({ data: { channels: [] } });
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
              organizationId: "org-destination",
              slug: checkRef.current.slug,
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

const OLD_CANONICAL_VARIABLES = {
  orgSlug: "source",
  checkSlug: "old-slug",
};

async function renderCanonicalPage(options?: {
  seedCanonicalCache?: boolean;
  rejectCanonicalLookup?: boolean;
  organizationId?: string;
  orgSlug?: string;
}) {
  const checkRef = {
    current: {
      ...INITIAL_CHECK,
      organizationId: options?.organizationId ?? INITIAL_CHECK.organizationId,
    },
  };
  const queryCount = { current: 0 };
  const variables: { current?: Record<string, unknown> } = {};
  const cache = new InMemoryCache();
  if (options?.seedCanonicalCache) {
    cache.writeQuery({
      query: CHECK_BY_ORGANIZATION_SLUG,
      variables: OLD_CANONICAL_VARIABLES,
      data: { checkByOrganizationSlug: { ...checkRef.current } },
    });
  }
  const client = new ApolloClient({
    link: makeCanonicalLink(checkRef, queryCount, variables, options),
    cache,
  });
  vi.spyOn(client, "refetchQueries").mockResolvedValue([]);

  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <ApolloProvider client={client}>
        <Suspense fallback={null}>
          <CanonicalCheckPage
            params={Promise.resolve({
              org: options?.orgSlug ?? "source",
              check: "old-slug",
            })}
          />
        </Suspense>
      </ApolloProvider>,
    );
  });

  return { checkRef, client, queryCount, variables, unmount: view.unmount };
}

function readOldCanonicalRoute(client: ApolloClient) {
  return client.cache.readQuery<{ checkByOrganizationSlug: CheckRecord }>({
    query: CHECK_BY_ORGANIZATION_SLUG,
    variables: OLD_CANONICAL_VARIABLES,
  });
}

function hasOldCanonicalRootEntry(client: ApolloClient) {
  const extracted = client.cache.extract() as Record<string, unknown>;
  const rootQuery = extracted.ROOT_QUERY as
    | Record<string, unknown>
    | undefined;
  return Object.keys(rootQuery ?? {}).some(
    (field) =>
      field.startsWith("checkByOrganizationSlug(") &&
      field.includes('"source"') &&
      field.includes('"old-slug"'),
  );
}

async function expectOldCanonicalRouteRequiresNetwork(
  client: ApolloClient,
  queryCount: { current: number },
) {
  const beforeRevisit = queryCount.current;
  await expect(
    client.query({
      query: CHECK_BY_ORGANIZATION_SLUG,
      variables: OLD_CANONICAL_VARIABLES,
    }),
  ).rejects.toThrow("Check not found");
  expect(queryCount.current).toBe(beforeRevisit + 1);
}

function submitEditForm() {
  const form = document.querySelector("form");
  if (!form) throw new Error("form not found");
  fireEvent.submit(form);
}

async function moveToDestination() {
  fireEvent.click(screen.getByRole("button", { name: "Move check" }));
  const selects = screen.getAllByRole("combobox");
  expect(selects).toHaveLength(1);
  fireEvent.click(selects[0]);
  fireEvent.click(await screen.findByRole("option", { name: "Destination Org" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Move check" }),
  );
}

describe("canonical organization/check route", () => {
  beforeEach(() => {
    navigation.replace.mockClear();
    setActiveOrgId.mockClear();
  });

  it("declares the organization-scoped slug query without a project argument", () => {
    const document = print(CHECK_BY_ORGANIZATION_SLUG);
    expect(document).toContain("query CheckByOrganizationSlug");
    expect(document).toContain(
      "checkByOrganizationSlug(orgSlug: $orgSlug, checkSlug: $checkSlug)",
    );
    expect(document).toContain("organizationId");
    expect(document).not.toContain("projectSlug");
  });

  it("queries the complete canonical tuple", async () => {
    const { variables } = await renderCanonicalPage();
    await screen.findByText("Nightly job");

    expect(variables.current).toEqual({
      orgSlug: "source",
      checkSlug: "old-slug",
    });
  });

  it("synchronizes the active organization after a direct canonical lookup", async () => {
    await renderCanonicalPage({
      orgSlug: "destination",
      organizationId: "org-destination",
    });

    await screen.findByText("Nightly job");
    await waitFor(() =>
      expect(setActiveOrgId).toHaveBeenCalledWith("org-destination"),
    );
    expect(
      screen.getByRole("link", { name: "Back to dashboard" }),
    ).toHaveAttribute("href", "/dashboard");
  });

  it("evicts a renamed check's old canonical route before replacing it", async () => {
    const { client, queryCount, unmount } = await renderCanonicalPage({
      seedCanonicalCache: true,
      rejectCanonicalLookup: true,
    });
    await screen.findByText("Nightly job");
    expect(readOldCanonicalRoute(client)?.checkByOrganizationSlug.slug).toBe(
      "old-slug",
    );
    expect(hasOldCanonicalRootEntry(client)).toBe(true);
    let cachedRouteAtNavigation:
      | ReturnType<typeof readOldCanonicalRoute>
      | undefined;
    let rootEntryAtNavigation: boolean | undefined;
    navigation.replace.mockImplementationOnce(() => {
      cachedRouteAtNavigation = readOldCanonicalRoute(client);
      rootEntryAtNavigation = hasOldCanonicalRootEntry(client);
    });

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/url slug/i), {
      target: { value: "new-slug" },
    });
    submitEditForm();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/source/new-slug"),
    );
    expect(cachedRouteAtNavigation).toBeNull();
    expect(rootEntryAtNavigation).toBe(false);
    unmount();
    await expectOldCanonicalRouteRequiresNetwork(client, queryCount);
  });

  it("refetches a non-slug edit in place", async () => {
    await renderCanonicalPage();
    await screen.findByText("Nightly job");

    fireEvent.click(screen.getByRole("button", { name: /edit/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: "Renamed job" },
    });
    submitEditForm();

    await screen.findByText("Renamed job");
    expect(navigation.replace).not.toHaveBeenCalled();
  });

  it("evicts a moved check's old canonical route before replacing it", async () => {
    const { client, queryCount, unmount } = await renderCanonicalPage({
      seedCanonicalCache: true,
      rejectCanonicalLookup: true,
    });
    await screen.findByText("Nightly job");
    expect(readOldCanonicalRoute(client)?.checkByOrganizationSlug.slug).toBe(
      "old-slug",
    );
    expect(hasOldCanonicalRootEntry(client)).toBe(true);
    let cachedRouteAtNavigation:
      | ReturnType<typeof readOldCanonicalRoute>
      | undefined;
    let rootEntryAtNavigation: boolean | undefined;
    navigation.replace.mockImplementationOnce(() => {
      cachedRouteAtNavigation = readOldCanonicalRoute(client);
      rootEntryAtNavigation = hasOldCanonicalRootEntry(client);
    });

    await moveToDestination();

    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/destination/old-slug"),
    );
    expect(cachedRouteAtNavigation).toBeNull();
    expect(rootEntryAtNavigation).toBe(false);
    expect(setActiveOrgId).toHaveBeenCalledWith("org-destination");
    expect(setActiveOrgId.mock.invocationCallOrder[0]).toBeLessThan(
      navigation.replace.mock.invocationCallOrder[0],
    );
    unmount();
    await expectOldCanonicalRouteRequiresNetwork(client, queryCount);
  });
});

const legacyRequest: { current?: Record<string, unknown> } = {};

function legacyClient(result: "success" | "missing" | "error" | "mismatched") {
  return new ApolloClient({
    cache: new InMemoryCache(),
    link: new ApolloLink((operation) =>
      new Observable((observer) => {
        if (operation.operationName !== "CheckBySlug") {
          observer.error(new Error(`Unexpected operation: ${operation.operationName}`));
          return;
        }
        legacyRequest.current = operation.variables;
        if (result === "error") {
          observer.error(new Error("Check not found"));
          return;
        }
        observer.next({
          data: {
            checkBySlug:
              result === "success"
                ? {
                    ...INITIAL_CHECK,
                    projectId: "legacy-project",
                    slug: "returned-slug",
                  }
                : result === "mismatched"
                  ? {
                      ...INITIAL_CHECK,
                      projectId: "",
                    }
                : null,
          },
        });
        observer.complete();
      }),
    ),
  });
}

async function renderLegacyPage(
  result: "success" | "missing" | "error" | "mismatched",
) {
  await act(async () => {
    render(
      <ApolloProvider client={legacyClient(result)}>
        <Suspense fallback={null}>
          <LegacyCheckPage
            params={Promise.resolve({
              org: "source",
              project: "legacy-project",
              check: "old-slug",
            })}
          />
        </Suspense>
      </ApolloProvider>,
    );
  });
}

describe("legacy organization/project/check route", () => {
  beforeEach(() => {
    navigation.permanentRedirect.mockClear();
    legacyRequest.current = undefined;
  });

  it("permanently redirects only after the authenticated full tuple resolves", async () => {
    await renderLegacyPage("success");

    await waitFor(() =>
      expect(navigation.permanentRedirect).toHaveBeenCalledWith(
        "/source/returned-slug",
      ),
    );
    expect(legacyRequest.current).toEqual({
      orgSlug: "source",
      projectSlug: "legacy-project",
      checkSlug: "old-slug",
    });
  });

  it.each(["missing", "error", "mismatched"] as const)(
    "does not redirect an inaccessible or %s tuple",
    async (result) => {
      await renderLegacyPage(result);

      await waitFor(() => expect(screen.getByRole("dialog")).toHaveTextContent("Error"));
      expect(navigation.permanentRedirect).not.toHaveBeenCalled();
    },
  );
});
