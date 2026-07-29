import { ApolloLink, InMemoryCache, Observable } from "@apollo/client";
import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { print } from "graphql";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_TOKENS, REVOKE_API_TOKEN } from "@/lib/queries";
import { AgentConnectionsPage } from "./page";

const now = new Date("2026-07-24T12:00:00.000Z");
interface TestToken {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  organizationId: string | null;
  projectName: string | null;
  organizationName: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

const active: TestToken = {
  id: "active",
  name: "Codex — Production",
  prefix: "svt_abcd",
  scopes: ["checks:read", "checks:write"],
  organizationId: "org-1",
  projectName: "Production",
  organizationName: "Acme",
  createdAt: "2026-07-20T12:00:00.000Z",
  expiresAt: null,
  lastUsedAt: null,
  revokedAt: null,
};
const expired: TestToken = {
  ...active,
  id: "expired",
  name: "Old deploy bot",
  expiresAt: "2026-07-23T12:00:00.000Z",
  lastUsedAt: "2026-07-22T12:00:00.000Z",
};
const revoked: TestToken = {
  ...active,
  id: "revoked",
  name: "Former Cursor",
  expiresAt: "2026-07-22T12:00:00.000Z",
  revokedAt: "2026-07-21T12:00:00.000Z",
};
const deletedProject: TestToken = {
  ...active,
  id: "deleted-project",
  name: "Historical project agent",
  organizationId: null,
  projectName: "Retired production",
  organizationName: "Acme",
};

const otherOrganization: TestToken = {
  ...active,
  id: "other-organization",
  name: "Other organization agent",
  organizationId: "org-2",
  organizationName: "Other organization",
};

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    activeOrg: {
      id: "org-1",
      name: "Acme",
      slug: "acme",
      role: "OWNER",
      plan: "SIGNAL",
      creatorUserId: "user-1",
      creatorLabel: "owner@example.com",
      pingKey: "ping-key",
    },
  }),
}));

function queryMock(tokens: TestToken[] = [active, expired, revoked]): MockedResponse {
  return {
    request: { query: API_TOKENS },
    result: { data: { apiTokens: tokens } },
  };
}

function renderPage(mocks: MockedResponse[] = [queryMock()]) {
  return render(
    <MockedProvider mocks={mocks}>
      <AgentConnectionsPage now={() => now} />
    </MockedProvider>,
  );
}

describe("AgentConnectionsPage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("queries exact non-secret connection metadata", () => {
    const document = print(API_TOKENS);
    expect(document).toBe(`query ApiTokens {
  apiTokens {
    id
    name
    prefix
    scopes
    organizationId
    projectName
    organizationName
    createdAt
    expiresAt
    lastUsedAt
    revokedAt
  }
}`);
    expect(document).not.toMatch(/plaintext|tokenHash/);
  });

  it("shows active, expired, and revoked history with revoked taking precedence", async () => {
    renderPage();

    const activeRow = await screen.findByRole("listitem", { name: /codex — production/i });
    const expiredRow = screen.getByRole("listitem", { name: /old deploy bot/i });
    const revokedRow = screen.getByRole("listitem", { name: /former cursor/i });

    expect(within(activeRow).getByText("Active")).toBeInTheDocument();
    expect(within(expiredRow).getByText("Expired")).toBeInTheDocument();
    expect(within(revokedRow).getByText("Revoked")).toBeInTheDocument();
    expect(within(activeRow).getByText("Acme")).toBeInTheDocument();
    expect(within(activeRow).getByText("Read checks")).toBeInTheDocument();
    expect(within(activeRow).getByText("Manage checks")).toBeInTheDocument();
    expect(within(activeRow).getByText("Never")).toBeInTheDocument();
    expect(within(activeRow).getByText("Never used")).toBeInTheDocument();
    expect(within(activeRow).getByText("svt_abcd…")).toBeInTheDocument();
    expect(within(activeRow).getByRole("button", { name: /revoke codex — production/i })).toBeEnabled();
    expect(within(expiredRow).getByRole("button", { name: /revoke old deploy bot/i })).toBeEnabled();
    expect(within(revokedRow).queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("uses neutral deleted-workspace copy without exposing a legacy project name", async () => {
    const legacy = {
      ...active,
      id: "legacy",
      name: "Legacy account token",
      organizationId: null,
      projectName: null,
      organizationName: null,
      scopes: ["read", "write"],
    };
    renderPage([queryMock([deletedProject, legacy])]);

    const deletedRow = await screen.findByRole("listitem", {
      name: /historical project agent/i,
    });
    const legacyRow = screen.getByRole("listitem", {
      name: /legacy account token/i,
    });
    expect(within(deletedRow).getByText("Inactive")).toBeInTheDocument();
    expect(
      within(deletedRow).getByText("Workspace unavailable"),
    ).toBeInTheDocument();
    expect(within(deletedRow).queryByText("Retired production")).toBeNull();
    expect(within(deletedRow).queryByText("Active")).not.toBeInTheDocument();
    expect(
      within(deletedRow).getByRole("button", {
        name: /revoke historical project agent/i,
      }),
    ).toBeEnabled();
    expect(within(legacyRow).getByText("Active")).toBeInTheDocument();
    expect(within(legacyRow).getByText("All organizations")).toBeInTheDocument();
  });

  it("filters canonical connection history to the active organization", async () => {
    renderPage([queryMock([active, otherOrganization])]);

    expect(
      await screen.findByRole("listitem", { name: /codex — production/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("listitem", { name: /other organization agent/i }),
    ).not.toBeInTheDocument();
  });

  it("revokes an expired credential that has not already been revoked", async () => {
    renderPage([
      queryMock([expired]),
      {
        request: { query: REVOKE_API_TOKEN, variables: { id: "expired" } },
        result: { data: { revokeApiToken: true } },
      },
      queryMock([{ ...expired, revokedAt: now.toISOString() }]),
    ]);
    const row = await screen.findByRole("listitem", { name: /old deploy bot/i });

    fireEvent.click(within(row).getByRole("button", { name: /revoke old deploy bot/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^revoke connection$/i,
      }),
    );

    await waitFor(() => expect(within(row).getByText("Revoked")).toBeInTheDocument());
    expect(within(row).queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("renders row-shaped loading skeletons", () => {
    renderPage([]);
    expect(screen.getByRole("status", { name: /loading agent connections/i })).toBeInTheDocument();
    expect(screen.getAllByTestId("connection-skeleton")).toHaveLength(3);
  });

  it("renders an accessible inline error and retries", async () => {
    renderPage([
      { request: { query: API_TOKENS }, error: new Error("offline") },
      queryMock([active]),
    ]);

    expect(await screen.findByRole("alert")).toHaveTextContent(/couldn't load agent connections/i);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("listitem", { name: /codex — production/i })).toBeInTheDocument();
  });

  it("directs an empty organization to its Connect agent action", async () => {
    renderPage([queryMock([])]);
    expect(await screen.findByText(/no agent connections yet/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to dashboard/i })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(
      screen.getByText(/open an organization and choose connect agent/i),
    ).toBeInTheDocument();
  });

  it("cancels revocation without mutating", async () => {
    renderPage();
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    const dialog = screen.getByRole("dialog", { name: /revoke agent connection/i });
    expect(within(dialog).getByText(/codex — production/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: /cancel/i }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /revoke agent connection/i })).toBeNull(),
    );
    expect(within(row).getByText("Active")).toBeInTheDocument();
  });

  it("shows Revoked immediately after successful confirmation", async () => {
    renderPage([
      queryMock([active]),
      {
        request: { query: REVOKE_API_TOKEN, variables: { id: "active" } },
        result: { data: { revokeApiToken: true } },
      },
      queryMock([{ ...active, revokedAt: now.toISOString() }]),
    ]);
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^revoke connection$/i }),
    );

    await waitFor(() => expect(within(row).getByText("Revoked")).toBeInTheDocument());
    expect(within(row).queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("shows revoked metadata while the authoritative refetch is still in flight", async () => {
    renderPage([
      queryMock([active]),
      {
        request: { query: REVOKE_API_TOKEN, variables: { id: "active" } },
        result: { data: { revokeApiToken: true } },
      },
      {
        ...queryMock([{ ...active, revokedAt: now.toISOString() }]),
        delay: 80,
      },
    ]);
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^revoke connection$/i }),
    );

    await waitFor(() => expect(within(row).getByText("Revoked")).toBeInTheDocument());
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: /revoking/i }),
    ).toBeDisabled();
  });

  it("keeps a revoked credential current after unmount and remount", async () => {
    const cache = new InMemoryCache();
    const mocks = [
      queryMock([active]),
      {
        request: { query: REVOKE_API_TOKEN, variables: { id: "active" } },
        result: { data: { revokeApiToken: true } },
      },
      queryMock([{ ...active, revokedAt: now.toISOString() }]),
      queryMock([{ ...active, revokedAt: now.toISOString() }]),
    ];
    const first = render(
      <MockedProvider mocks={mocks} cache={cache}>
        <AgentConnectionsPage now={() => now} />
      </MockedProvider>,
    );
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^revoke connection$/i }),
    );
    await waitFor(() => expect(within(row).getByText("Revoked")).toBeInTheDocument());
    first.unmount();

    render(
      <MockedProvider mocks={mocks} cache={cache}>
        <AgentConnectionsPage now={() => now} />
      </MockedProvider>,
    );
    const remounted = await screen.findByRole("listitem", {
      name: /codex — production/i,
    });
    expect(within(remounted).getByText("Revoked")).toBeInTheDocument();
    expect(within(remounted).queryByRole("button", { name: /revoke/i })).toBeNull();
  });

  it("transitions an active connection to expired at its expiration boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const soon = {
      ...active,
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
    };
    const cache = new InMemoryCache();
    cache.writeQuery({
      query: API_TOKENS,
      data: { apiTokens: [soon] },
    });
    render(
      <MockedProvider mocks={[queryMock([soon])]} cache={cache}>
        <AgentConnectionsPage />
      </MockedProvider>,
    );
    const row = screen.getByRole("listitem", { name: /codex — production/i });
    expect(within(row).getByText("Active")).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(within(row).getByText("Expired")).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: /revoke codex — production/i })).toBeEnabled();
  });

  it("keeps the connection active and reports a failed revocation", async () => {
    renderPage([
      queryMock([active]),
      {
        request: { query: REVOKE_API_TOKEN, variables: { id: "active" } },
        error: new Error("failed"),
      },
    ]);
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^revoke connection$/i }),
    );

    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      /couldn't revoke/i,
    );
    expect(within(row).getByText("Active")).toBeInTheDocument();
  });

  it("keeps the connection active when the API does not confirm revocation", async () => {
    renderPage([
      queryMock([active]),
      {
        request: { query: REVOKE_API_TOKEN, variables: { id: "active" } },
        result: { data: { revokeApiToken: false } },
      },
    ]);
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: /^revoke connection$/i }),
    );

    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      /couldn't revoke/i,
    );
    expect(within(row).getByText("Active")).toBeInTheDocument();
  });

  it("does not update revoke state after the page unmounts", async () => {
    let completeMutation: (() => void) | undefined;
    const link = new ApolloLink(
      (operation) =>
        new Observable((observer) => {
          if (operation.operationName === "ApiTokens") {
            observer.next({ data: { apiTokens: [active] } });
            observer.complete();
            return;
          }
          completeMutation = () => {
            observer.next({ data: { revokeApiToken: true } });
            observer.complete();
          };
        }),
    );
    const view = render(
      <MockedProvider link={link}>
        <AgentConnectionsPage now={() => now} />
      </MockedProvider>,
    );
    const row = await screen.findByRole("listitem", {
      name: /codex — production/i,
    });
    fireEvent.click(
      within(row).getByRole("button", { name: /revoke codex — production/i }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /^revoke connection$/i,
      }),
    );
    await waitFor(() => expect(completeMutation).toBeTypeOf("function"));

    view.unmount();
    await new Promise((resolve) => setImmediate(resolve));
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    const unhandledReasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandledReasons.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      try {
        Reflect.deleteProperty(globalThis, "window");
        completeMutation?.();
        for (let step = 0; step < 10; step += 1) {
          await Promise.resolve();
        }
      } finally {
        if (windowDescriptor) {
          Object.defineProperty(globalThis, "window", windowDescriptor);
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    expect(unhandledReasons).toEqual([]);
  });

  it("guards the revoke mutation against duplicate confirmation clicks", async () => {
    let calls = 0;
    const link = new ApolloLink(
      (operation) =>
        new Observable((observer) => {
          if (operation.operationName === "ApiTokens") {
            observer.next({ data: { apiTokens: [active] } });
            observer.complete();
            return;
          }
          calls += 1;
          setTimeout(() => {
            observer.next({ data: { revokeApiToken: true } });
            observer.complete();
          }, 20);
        }),
    );
    render(
      <MockedProvider link={link}>
        <AgentConnectionsPage now={() => now} />
      </MockedProvider>,
    );
    const row = await screen.findByRole("listitem", { name: /codex — production/i });
    fireEvent.click(within(row).getByRole("button", { name: /revoke codex — production/i }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", {
      name: /^revoke connection$/i,
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(calls).toBe(1);
    expect(confirm).toBeDisabled();
  });
});
