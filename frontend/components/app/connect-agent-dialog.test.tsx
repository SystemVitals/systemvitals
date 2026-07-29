import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { InMemoryCache } from "@apollo/client";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Link from "next/link";
import { StrictMode } from "react";

import { API_TOKENS, CREATE_API_TOKEN } from "@/lib/queries";
import { ConnectAgentDialog } from "./connect-agent-dialog";
import { AgentConnectionsPage } from "@/app/(app)/account/agent-connections/page";

const plaintext = "svt_once_only_secret";
const organization = { organizationId: "org_123", organizationName: "Production" };
const mockRouterPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush }),
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    activeOrg: {
      id: "org_123",
      name: "Production",
      slug: "production",
      role: "OWNER",
      plan: "SIGNAL",
      creatorUserId: "user-1",
      creatorLabel: "owner@example.com",
      pingKey: "ping-key",
    },
  }),
}));

function successResult(name: string) {
  return {
    data: {
      createScopedApiToken: {
        id: "token_123",
        name,
        scopes: ["checks:read", "checks:write"],
        organizationId: "org_123",
        expiresAt: null,
        plaintext,
      },
    },
  };
}

function successMock(
  input: Record<string, unknown> = {
    name: "Claude Code — Production",
    capabilities: ["checks:read", "checks:write"],
    organizationId: "org_123",
  },
): MockedResponse {
  return {
    request: { query: CREATE_API_TOKEN, variables: { input } },
    result: successResult(String(input.name)),
  };
}

function transportFailureMock(): MockedResponse {
  return {
    request: {
      query: CREATE_API_TOKEN,
      variables: {
        input: {
          name: "Claude Code — Production",
          capabilities: ["checks:read", "checks:write"],
          organizationId: "org_123",
        },
      },
    },
    error: new Error("Failed to fetch"),
  };
}

function renderDialog(mocks: MockedResponse[] = [successMock()]) {
  return render(
    <MockedProvider mocks={mocks}>
      <ConnectAgentDialog {...organization} />
    </MockedProvider>,
  );
}

function renderDialogWithInternalLink(
  mocks: MockedResponse[] = [successMock()],
) {
  return render(
    <MockedProvider mocks={mocks}>
      <div>
        <Link href="/channels?view=active#email">Channels</Link>
        <Link href="/team" target="_self">Team</Link>
        <Link href="/billing" target="billing-window" onClick={(event) => event.preventDefault()}>Billing window</Link>
        <Link href="/account" target="_parent" onClick={(event) => event.preventDefault()}>Account parent</Link>
        <Link href="/organizations" target="_top" onClick={(event) => event.preventDefault()}>Organizations top</Link>
        <Link href="/status-pages" target="_blank" onClick={(event) => event.preventDefault()}>Status pages new tab</Link>
        <ConnectAgentDialog {...organization} />
      </div>
    </MockedProvider>,
  );
}

function renderStrictDialog(mocks: MockedResponse[] = [successMock()]) {
  return render(
    <StrictMode>
      <MockedProvider mocks={mocks}>
        <ConnectAgentDialog {...organization} />
      </MockedProvider>
    </StrictMode>,
  );
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: /connect agent/i }));
  return screen.findByRole("dialog", { name: /connect agent/i });
}

async function createConnection() {
  await openDialog();
  fireEvent.click(screen.getByRole("button", { name: /create connection/i }));
  await screen.findByText(plaintext);
}

describe("ConnectAgentDialog", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRouterPush.mockReset();
    history.replaceState(null, "", "/dashboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("names the organization and makes the fixed authority and exclusions explicit", async () => {
    const dialog = await openDialogWithRender();

    expect(within(dialog).getAllByText("Production").length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/view checks and recent status/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/create, edit, pause, resume, and delete checks/i)).toBeInTheDocument();
    expect(
      within(dialog).getByText(/no access to members, billing, notification channels, or other organizations/i),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/connection name/i)).toHaveValue("Claude Code — Production");
  });

  it("tracks the selected client in the default name until the user edits it", async () => {
    const dialog = await openDialogWithRender();
    const name = within(dialog).getByLabelText(/connection name/i);

    fireEvent.click(within(dialog).getByRole("combobox", { name: /agent client/i }));
    await chooseOption("Codex");
    expect(name).toHaveValue("Codex — Production");

    fireEvent.change(name, { target: { value: "My pinned agent" } });
    fireEvent.click(within(dialog).getByRole("combobox", { name: /agent client/i }));
    await chooseOption("Cursor");
    expect(name).toHaveValue("My pinned agent");
  });

  it("defaults expiration to Never", async () => {
    const dialog = await openDialogWithRender();
    expect(within(dialog).getByRole("combobox", { name: /expiration/i })).toHaveTextContent("Never");
  });

  it("validates custom expiration as an integer from 1 through 3650", async () => {
    const dialog = await openDialogWithRender();
    fireEvent.click(within(dialog).getByRole("combobox", { name: /expiration/i }));
    await chooseOption("Custom");

    const custom = await within(dialog).findByLabelText(/custom expiration/i);
    fireEvent.change(custom, { target: { value: "30" } });
    expect(custom).toHaveAttribute("aria-describedby", "agent-custom-days-help");
    expect(document.getElementById("agent-custom-days-help")).toBeInTheDocument();
    expect(document.getElementById("agent-custom-days-error")).not.toBeInTheDocument();
    for (const value of ["0", "3651", "1.5"]) {
      fireEvent.change(custom, { target: { value } });
      expect(within(dialog).getByRole("alert")).toHaveTextContent(/whole number from 1 to 3650/i);
      expect(custom).toHaveAttribute(
        "aria-describedby",
        "agent-custom-days-help agent-custom-days-error",
      );
      expect(document.getElementById("agent-custom-days-error")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /create connection/i })).toBeDisabled();
    }

    fireEvent.change(custom, { target: { value: "3650" } });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(custom).toHaveAttribute("aria-describedby", "agent-custom-days-help");
    expect(within(dialog).getByRole("button", { name: /create connection/i })).toBeEnabled();
  });

  it("keeps definitive client validation failures outside the credential-risk state", async () => {
    const result = vi.fn(() => successResult("Claude Code — Production"));
    renderDialog([{ ...successMock(), result }]);
    const dialog = await openDialog();
    fireEvent.click(within(dialog).getByRole("combobox", { name: /expiration/i }));
    await chooseOption("Custom");
    fireEvent.change(await within(dialog).findByLabelText(/custom expiration/i), {
      target: { value: "0" },
    });

    const submit = within(dialog).getByRole("button", {
      name: /create connection/i,
    });
    fireEvent.submit(submit.closest("form")!);

    expect(result).not.toHaveBeenCalled();
    expect(
      within(dialog).queryByRole("alert", { name: /connection status unknown/i }),
    ).not.toBeInTheDocument();
    expect(dispatchBeforeUnload()).toBe(false);
  });

  it("submits the organization, fixed capabilities, name, and expiration days", async () => {
    renderDialog([
      successMock({
        name: "Deploy bot",
        capabilities: ["checks:read", "checks:write"],
        organizationId: "org_123",
        expirationDays: 30,
      }),
    ]);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText(/connection name/i), {
      target: { value: "Deploy bot" },
    });
    fireEvent.click(within(dialog).getByRole("combobox", { name: /expiration/i }));
    await chooseOption("30 days");
    fireEvent.click(within(dialog).getByRole("button", { name: /create connection/i }));

    expect(await screen.findByText(plaintext)).toBeInTheDocument();
  });

  it("shows the one-time plaintext result, warnings, five client tabs, and test prompt", async () => {
    renderDialog();
    await createConnection();

    expect(screen.getByText(/cannot be displayed again/i)).toBeInTheDocument();
    expect(screen.getAllByText(/shell history/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/never commit (the )?token or (generated )?config/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "GraphQL/cURL" }));
    expect(screen.getByText(/never commit (the )?token or (generated )?config/i)).toBeVisible();
    expect(screen.getByText(/create a 5-minute heartbeat check named nightly-backup/i)).toBeInTheDocument();
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    for (const name of ["Claude Code", "Codex", "Cursor", "Universal JSON", "GraphQL/cURL"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
  });

  it("explains which generated setups persist the bearer secret", async () => {
    renderDialog();
    await createConnection();

    expect(screen.getByText(/claude cli stores the credential in its mcp config/i)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Codex" }));
    expect(screen.getByText(/config file contains the bearer secret/i)).toBeVisible();
    expect(screen.getByText(/user-only permissions/i)).toBeVisible();
    expect(screen.getByText(/revoke.*no longer needed/i)).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "GraphQL/cURL" }));
    expect(screen.getByText(/prompts for the token without putting it in shell history/i)).toBeVisible();
  });

  it("renders generated configuration for all five clients using the normalized public GraphQL URL", async () => {
    renderDialog();
    await createConnection();

    const expected = [
      ["Claude Code", "claude mcp add"],
      ["Codex", "[mcp_servers."],
      ["Cursor", '"mcpServers"'],
      ["Universal JSON", '"mcpServers"'],
      ["GraphQL/cURL", "curl --request POST"],
    ];
    for (const [tab, fragment] of expected) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(await screen.findByText((text) => text.includes(fragment))).toHaveTextContent(
        "http://localhost:8888/graphql",
      );
    }
  });

  it("copies the generated setup and records copied state", async () => {
    renderDialog();
    await createConnection();
    fireEvent.click(screen.getByRole("button", { name: /copy setup/i }));

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: /copied/i })).toBeInTheDocument();
  });

  it.each(["Claude Code", "GraphQL/cURL"])(
    "keeps the one-time token guarded after copying %s setup until the token itself is saved",
    async (clientName) => {
      renderDialog();
      await createConnection();
      if (clientName !== "Claude Code") {
        fireEvent.click(screen.getByRole("tab", { name: clientName }));
      }

      fireEvent.click(screen.getByRole("button", { name: /copy setup/i }));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledOnce());
      expect(vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0]).not.toContain(
        plaintext,
      );

      fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
      const confirmation = await screen.findByRole("dialog", {
        name: /discard uncopied token/i,
      });
      fireEvent.click(within(confirmation).getByRole("button", { name: /keep open/i }));

      fireEvent.click(screen.getByRole("button", { name: /copy token/i }));
      await waitFor(() =>
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(plaintext),
      );
      expect(screen.getByRole("button", { name: /token copied/i })).toBeInTheDocument();

      fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
      expect(
        screen.queryByRole("dialog", { name: /discard uncopied token/i }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    },
  );

  it("accepts an explicit acknowledgement after the user saves the token manually", async () => {
    renderDialog();
    await createConnection();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /i saved this one-time token securely/i,
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

    expect(
      screen.queryByRole("dialog", { name: /discard uncopied token/i }),
    ).not.toBeInTheDocument();
    expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
  });

  it("keeps copied false and shows a generic inline error when Clipboard API is missing", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    renderDialog();
    await createConnection();
    fireEvent.click(screen.getByRole("button", { name: /copy setup/i }));

    const alert = await screen.findByRole("alert", { name: /copy failed/i });
    expect(alert).toHaveTextContent(/copy it manually/i);
    expect(alert).not.toHaveTextContent(plaintext);
    expect(screen.queryByRole("button", { name: /copied/i })).not.toBeInTheDocument();
  });

  it("keeps copied false and shows a generic inline error when clipboard write rejects", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error(`do not expose ${plaintext}`),
    );
    renderDialog();
    await createConnection();
    fireEvent.click(screen.getByRole("button", { name: /copy setup/i }));

    const alert = await screen.findByRole("alert", { name: /copy failed/i });
    expect(alert).not.toHaveTextContent(plaintext);
    expect(screen.queryByRole("button", { name: /copied/i })).not.toBeInTheDocument();
  });

  it("allows only one mutation during rapid duplicate submission", async () => {
    const result = vi.fn(() => successResult("Claude Code — Production"));
    renderDialog([
      {
        ...successMock(),
        delay: 20,
        result,
      },
    ]);
    await openDialog();
    const submit = screen.getByRole("button", { name: /create connection/i });
    fireEvent.click(submit);
    fireEvent.click(submit);

    await screen.findByText(plaintext);
    expect(result).toHaveBeenCalledOnce();
  });

  it("retains the dialog through every dismiss path while token creation is in flight", async () => {
    renderDialog([
      {
        ...successMock(),
        delay: 80,
      },
    ]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /create connection/i }));

    const cancel = screen.getByRole("button", { name: /cancel/i });
    expect(cancel).toBeDisabled();
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
    fireEvent.click(cancel);
    fireEvent.keyDown(document, { key: "Escape" });
    const backdrop = document.querySelector<HTMLElement>(
      '[data-slot="dialog-overlay"]',
    );
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop!);
    fireEvent.mouseDown(backdrop!);
    fireEvent.click(backdrop!);

    expect(
      screen.getByRole("dialog", { name: /connect agent/i }),
    ).toBeInTheDocument();
    expect(await screen.findByText(plaintext)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /copy token/i }));
    await screen.findByRole("button", { name: /token copied/i });
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /connect agent/i }),
    ).not.toBeInTheDocument();
  });

  it("requires shadcn discard confirmation before closing an uncopied result", async () => {
    renderDialog();
    await createConnection();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

    const confirmation = await screen.findByRole("dialog", { name: /discard uncopied token/i });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(within(confirmation).getByRole("button", { name: /keep open/i })).toHaveFocus();
    expect(within(confirmation).getByText(/cannot recover this token/i)).toBeInTheDocument();
    fireEvent.click(within(confirmation).getByRole("button", { name: /keep open/i }));
    expect(screen.getByText(plaintext)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^close$/i })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    fireEvent.click(
      within(await screen.findByRole("dialog", { name: /discard uncopied token/i })).getByRole(
        "button",
        { name: /discard token/i },
      ),
    );
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
  });

  it("retains the risk warning and blocks dismissal and navigation when the creation response is lost", async () => {
    renderDialogWithInternalLink([transportFailureMock()]);
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /create connection/i }),
    );

    const warning = await screen.findByRole("alert", {
      name: /connection status unknown/i,
    });
    expect(warning).toHaveTextContent(/connection may have been created/i);
    expect(warning).toHaveTextContent(/one-time secret was not received/i);
    expect(warning).toHaveTextContent(/agent connections/i);
    expect(warning).not.toHaveTextContent(/failed to fetch|could not be created/i);
    expect(dispatchBeforeUnload()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    const closeBlocked = await screen.findByRole("dialog", {
      name: /acknowledge potential connection/i,
    });
    expect(
      within(closeBlocked).queryByRole("button", {
        name: /discard|leave|continue/i,
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(closeBlocked).getByRole("button", { name: /keep open/i }),
    );

    fireEvent.click(
      document.querySelector<HTMLAnchorElement>(
        'a[href="/channels?view=active#email"]',
      )!,
    );
    expect(
      await screen.findByRole("dialog", {
        name: /acknowledge potential connection/i,
      }),
    ).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("routes to Agent connections only after acknowledging a potentially created credential", async () => {
    renderDialog([transportFailureMock()]);
    const dialog = await openDialog();
    fireEvent.click(
      within(dialog).getByRole("button", { name: /create connection/i }),
    );

    await screen.findByRole("alert", {
      name: /connection status unknown/i,
    });
    const reviewConnections = screen.getByRole("button", {
      name: /review agent connections/i,
    });
    expect(reviewConnections).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /i understand.*connection may have been created.*review agent connections/i,
      }),
    );
    expect(reviewConnections).toBeEnabled();
    await waitFor(() => expect(dispatchBeforeUnload()).toBe(false));

    fireEvent.click(reviewConnections);
    expect(mockRouterPush).toHaveBeenCalledWith(
      "/account/agent-connections",
    );
    expect(
      screen.queryByRole("dialog", { name: /connect agent/i }),
    ).not.toBeInTheDocument();
  });

  it("clears copied secrets synchronously on close and never persists them", async () => {
    const localSet = vi.spyOn(Storage.prototype, "setItem");
    const historyPush = vi.spyOn(history, "pushState");
    const { rerender } = renderDialog();
    await createConnection();
    fireEvent.click(screen.getByRole("button", { name: /copy token/i }));
    await screen.findByRole("button", { name: /token copied/i });
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(localSet).not.toHaveBeenCalled();
    expect(JSON.stringify(historyPush.mock.calls)).not.toContain(plaintext);
    expect(window.location.pathname).toBe("/dashboard");

    rerender(
      <MockedProvider mocks={[]}>
        <ConnectAgentDialog {...organization} />
      </MockedProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /connect agent/i }));
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
  });

  it("never writes the one-time plaintext to Apollo cache", async () => {
    const cache = new InMemoryCache();
    render(
      <MockedProvider mocks={[successMock()]} cache={cache}>
        <ConnectAgentDialog {...organization} />
      </MockedProvider>,
    );
    await createConnection();

    expect(JSON.stringify(cache.extract())).not.toContain(plaintext);
  });

  it("invalidates stale token history so a later list visit loads the created connection", async () => {
    const cache = new InMemoryCache();
    cache.writeQuery({
      query: API_TOKENS,
      data: { apiTokens: [] },
    });
    const createdMetadata = {
      id: "token_123",
      name: "Claude Code — Production",
      prefix: "svt_new",
      scopes: ["checks:read", "checks:write"],
      organizationId: "org_123",
      organizationName: "Production",
      projectName: null,
      createdAt: "2026-07-24T12:00:00.000Z",
      expiresAt: null,
      lastUsedAt: null,
      revokedAt: null,
    };
    const creation = render(
      <MockedProvider mocks={[successMock()]} cache={cache}>
        <ConnectAgentDialog {...organization} />
      </MockedProvider>,
    );
    await createConnection();
    expect(cache.readQuery({ query: API_TOKENS })).toBeNull();
    expect(JSON.stringify(cache.extract())).not.toContain(plaintext);
    creation.unmount();

    render(
      <MockedProvider
        mocks={[
          {
            request: { query: API_TOKENS },
            result: { data: { apiTokens: [createdMetadata] } },
          },
        ]}
        cache={cache}
      >
        <AgentConnectionsPage />
      </MockedProvider>,
    );
    expect(
      await screen.findByRole("listitem", { name: /claude code — production/i }),
    ).toBeInTheDocument();
  });

  it("is StrictMode-safe across repeated real Back cancel and confirm flows", async () => {
    history.pushState(null, "", "/previous");
    history.pushState(null, "", "/dashboard");
    const pushState = vi.spyOn(history, "pushState");
    renderStrictDialog();
    await createConnection();
    await waitFor(() =>
      expect(
        pushState.mock.calls.filter(([state]) =>
          JSON.stringify(state).includes("__systemVitalsAgentSecretGuard"),
        ),
      ).toHaveLength(1),
    );

    history.back();
    const confirmation = await screen.findByRole("dialog", {
      name: /discard uncopied token/i,
    });
    fireEvent.click(within(confirmation).getByRole("button", { name: /keep open/i }));
    expect(screen.getByText(plaintext)).toBeInTheDocument();

    history.back();
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: /discard uncopied token/i }),
      ).getByRole("button", { name: /discard token/i }),
    );

    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    await waitFor(() => expect(window.location.pathname).toBe("/previous"));
  });

  it("can close and reopen safely before cleanup Back settles", async () => {
    history.pushState(null, "", "/previous-reopen");
    history.pushState(null, "", "/dashboard");
    renderStrictDialog([successMock(), successMock()]);
    await createConnection();
    fireEvent.click(screen.getByRole("button", { name: /copy token/i }));
    await screen.findByRole("button", { name: /token copied/i });
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));

    await createConnection();
    await waitFor(() =>
      expect(
        JSON.stringify(history.state),
      ).toContain("__systemVitalsAgentSecretGuard"),
    );
    history.back();

    expect(
      await screen.findByRole("dialog", { name: /discard uncopied token/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
  });

  it("intercepts same-origin links in capture phase and preserves the secret on cancel", async () => {
    renderDialogWithInternalLink();
    await createConnection();
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="/channels?view=active#email"]',
    );
    expect(link).not.toBeNull();

    fireEvent.click(link!);
    const confirmation = await screen.findByRole("dialog", {
      name: /discard uncopied token/i,
    });
    fireEvent.click(within(confirmation).getByRole("button", { name: /keep open/i }));

    expect(screen.getByText(plaintext)).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("intercepts same-origin links as soon as token creation begins", async () => {
    render(
      <MockedProvider mocks={[{ ...successMock(), delay: 200 }]}>
        <div>
          <Link href="/channels">Channels</Link>
          <ConnectAgentDialog {...organization} />
        </div>
      </MockedProvider>,
    );
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /create connection/i }));
    fireEvent.click(document.querySelector<HTMLAnchorElement>('a[href="/channels"]')!);

    const confirmation = await screen.findByRole("dialog", {
      name: /leave while connection is being created/i,
    });
    expect(
      within(confirmation).getByText(/active token that has never been shown/i),
    ).toBeInTheDocument();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("intercepts Back as soon as token creation begins", async () => {
    history.pushState(null, "", "/previous-creating");
    history.pushState(null, "", "/dashboard");
    renderDialog([{ ...successMock(), delay: 200 }]);
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: /create connection/i }));

    await waitFor(() =>
      expect(JSON.stringify(history.state)).toContain(
        "__systemVitalsAgentSecretGuard",
      ),
    );
    history.back();

    expect(
      await screen.findByRole("dialog", {
        name: /leave while connection is being created/i,
      }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
  });

  it("blocks beforeunload from creation start through result display, then releases it", async () => {
    renderDialog([{ ...successMock(), delay: 80 }]);
    await openDialog();

    expect(dispatchBeforeUnload()).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /create connection/i }));
    expect(dispatchBeforeUnload()).toBe(true);

    await screen.findByText(plaintext);
    expect(dispatchBeforeUnload()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /copy token/i }));
    await screen.findByRole("button", { name: /token copied/i });
    await waitFor(() => expect(dispatchBeforeUnload()).toBe(false));
  });

  it("clears the secret before continuing same-origin navigation through Next router", async () => {
    renderDialogWithInternalLink();
    await createConnection();
    const link = document.querySelector<HTMLAnchorElement>(
      'a[href="/channels?view=active#email"]',
    );

    fireEvent.click(link!);
    fireEvent.click(
      within(
        await screen.findByRole("dialog", { name: /discard uncopied token/i }),
      ).getByRole("button", { name: /discard token/i }),
    );

    expect(screen.queryByText(plaintext)).not.toBeInTheDocument();
    expect(mockRouterPush).toHaveBeenCalledWith("/channels?view=active#email");
  });

  it("intercepts _self links but leaves named and browsing-context targets untouched", async () => {
    renderDialogWithInternalLink();
    await createConnection();

    fireEvent.click(document.querySelector<HTMLAnchorElement>('a[href="/team"]')!);
    expect(
      await screen.findByRole("dialog", { name: /discard uncopied token/i }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /keep open/i }));

    for (const href of ["/billing", "/account", "/organizations", "/status-pages"]) {
      fireEvent.click(document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`)!);
      expect(
        screen.queryByRole("dialog", { name: /discard uncopied token/i }),
      ).not.toBeInTheDocument();
    }
  });

  it("removes navigation listeners when the guarded result unmounts", async () => {
    const { unmount } = renderDialog();
    await createConnection();
    unmount();

    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(
      screen.queryByRole("dialog", { name: /discard uncopied token/i }),
    ).not.toBeInTheDocument();
  });

  it("does not remove a history guard owned by another workflow", async () => {
    const historyBack = vi.spyOn(history, "back");
    const { unmount } = renderDialog();
    await createConnection();
    await waitFor(() =>
      expect(JSON.stringify(history.state)).toContain(
        "__systemVitalsAgentSecretGuard",
      ),
    );
    history.replaceState(
      { __systemVitalsAgentSecretGuard: "another-owner" },
      "",
      window.location.href,
    );

    unmount();
    expect(historyBack).not.toHaveBeenCalled();
  });
});

async function openDialogWithRender() {
  renderDialog();
  return openDialog();
}

async function chooseOption(name: string) {
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
}

function dispatchBeforeUnload() {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
