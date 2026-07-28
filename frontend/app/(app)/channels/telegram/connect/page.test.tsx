import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { InMemoryCache } from "@apollo/client";
import type { MockedResponse } from "@apollo/client/testing";
import { MockedProvider } from "@apollo/client/testing/react";
import { GraphQLError } from "graphql";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNELS,
  CONNECT_TELEGRAM_CHANNEL,
  TELEGRAM_CONNECTION_PREVIEW,
} from "@/lib/queries";
import { metadata } from "./layout";
import TelegramConnectPage from "./page";

const push = vi.fn();
const setActiveOrgId = vi.fn();
let searchParams = new URLSearchParams();
let searchParamsSuspends = false;
let challengeToken = "challenge-secret";
const pendingSearchParams = new Promise<never>(() => undefined);

const organizations = [
  {
    id: "org-1",
    name: "Northstar",
    projects: [
      { id: "project-1", name: "Production" },
      { id: "project-2", name: "Staging" },
    ],
  },
  {
    id: "org-2",
    name: "Workshop",
    projects: [{ id: "project-3", name: "Telemetry Lab" }],
  },
];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => {
    if (searchParamsSuspends) throw pendingSearchParams;
    return new URLSearchParams(searchParams.toString());
  },
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: "user-1",
      email: "ops@example.com",
      organizations,
    },
  }),
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ setActiveOrgId }),
}));

const previewData = {
  telegramConnectionPreview: {
    chatId: "-100123",
    chatType: "supergroup",
    chatTitle: "Incident Command",
    messageThreadId: 42,
    expiresAt: "2026-07-27T18:00:00.000Z",
  },
};

function previewMock(
  result: MockedResponse["result"] = { data: previewData },
): MockedResponse {
  return {
    request: {
      query: TELEGRAM_CONNECTION_PREVIEW,
      variables: { token: challengeToken },
    },
    result,
  };
}

function renderPage(
  mocks: MockedResponse[] = [],
  cache?: InMemoryCache,
) {
  return render(
    <MockedProvider mocks={mocks} cache={cache}>
      <TelegramConnectPage />
    </MockedProvider>,
  );
}

async function chooseProject(name: string) {
  const select = await screen.findByRole("combobox", {
    name: "Destination project",
  });
  fireEvent.click(select);
  const option = await screen.findByRole("option", { name });
  fireEvent.pointerDown(option);
  fireEvent.pointerUp(option);
  fireEvent.click(option);
  await waitFor(() => expect(select).toHaveTextContent(name));
}

describe("TelegramConnectPage", () => {
  beforeEach(() => {
    challengeToken = "challenge-secret";
    searchParams = new URLSearchParams({ token: challengeToken });
    searchParamsSuspends = false;
    push.mockReset();
    setActiveOrgId.mockClear();
    localStorage.clear();
    window.history.replaceState(
      {},
      "",
      `/channels/telegram/connect?token=${challengeToken}`,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an invalid-link state for a missing token without issuing a preview query", async () => {
    searchParams = new URLSearchParams();
    window.history.replaceState({}, "", "/channels/telegram/connect");
    const previewResult = vi.fn(() => ({ data: previewData }));

    renderPage([
      {
        request: {
          query: TELEGRAM_CONNECTION_PREVIEW,
          variables: { token: "challenge-secret" },
        },
        result: previewResult,
      },
    ]);

    expect(
      await screen.findByRole("heading", {
        name: "This connection link is invalid",
      }),
    ).toBeInTheDocument();
    expect(previewResult).not.toHaveBeenCalled();
  });

  it("scrubs the token before exactly one Strict Mode preview", async () => {
    const events: string[] = [];
    const originalReplaceState = window.history.replaceState.bind(window.history);
    const replaceState = vi
      .spyOn(window.history, "replaceState")
      .mockImplementation((data, unused, url) => {
        events.push("replace");
        originalReplaceState(data, unused, url);
      });
    const result = vi.fn(() => {
      events.push("preview");
      return { data: previewData };
    });

    const strictModePreview = {
      ...previewMock(result),
      maxUsageCount: 2,
    };

    render(
      <StrictMode>
        <MockedProvider mocks={[strictModePreview]}>
          <TelegramConnectPage />
        </MockedProvider>
      </StrictMode>,
    );

    await screen.findByText("Incident Command");
    expect(replaceState).toHaveBeenCalledWith(
      {},
      "",
      "/channels/telegram/connect",
    );
    expect(events).toEqual(["replace", "preview"]);
    expect(result).toHaveBeenCalledOnce();
    expect(window.location.search).toBe("");
  });

  it("does not retain the preview bearer token in Apollo cache state", async () => {
    challengeToken = "cache-sensitive-preview-token";
    searchParams = new URLSearchParams({ token: challengeToken });
    window.history.replaceState(
      {},
      "",
      `/channels/telegram/connect?token=${challengeToken}`,
    );
    const cache = new InMemoryCache();

    renderPage([previewMock()], cache);

    await screen.findByText("Incident Command");

    expect(JSON.stringify(cache.extract())).not.toContain(challengeToken);
  });

  it("renders the default export fallback when search params suspend", () => {
    searchParamsSuspends = true;

    renderPage();

    expect(
      screen.getByLabelText("Loading Telegram connection"),
    ).toHaveAttribute("aria-busy", "true");
  });

  it("displays the Telegram destination title, type, and topic", async () => {
    renderPage([previewMock()]);

    expect(await screen.findByText("Incident Command")).toBeInTheDocument();
    expect(screen.getByText("Supergroup")).toBeInTheDocument();
    expect(screen.getByText("Topic 42")).toBeInTheDocument();
  });

  it("renders a safe fallback when Telegram does not provide a chat title", async () => {
    renderPage([
      previewMock({
        data: {
          telegramConnectionPreview: {
            ...previewData.telegramConnectionPreview,
            chatType: "private",
            chatTitle: null,
          },
        },
      }),
    ]);

    expect(
      await screen.findByText("Unnamed private chat"),
    ).toBeInTheDocument();
    expect(screen.queryByText("-100123")).not.toBeInTheDocument();
  });

  it("shows the challenge expiry in semantic time markup", async () => {
    renderPage([previewMock()]);

    await screen.findByText("Incident Command");
    const time = document.querySelector("time");
    expect(time).not.toBeNull();
    expect(time).toHaveAttribute(
      "datetime",
      previewData.telegramConnectionPreview.expiresAt,
    );
    expect(time?.parentElement).toHaveTextContent(/connection link expires/i);
  });

  it("groups selectable projects from every accessible organization", async () => {
    renderPage([previewMock()]);

    fireEvent.click(
      await screen.findByRole("combobox", { name: "Destination project" }),
    );

    expect(screen.getByText("Northstar")).toBeInTheDocument();
    expect(screen.getByText("Workshop")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Production" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Staging" })).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Telemetry Lab" }),
    ).toBeInTheDocument();
  });

  it("connects the selected project, activates its organization, and opens its channels", async () => {
    const connectResult = vi.fn(() => ({
      data: {
        connectTelegramChannel: {
          id: "channel-1",
          type: "TELEGRAM",
          configJson: "{}",
          enabled: true,
          projectId: "project-3",
        },
      },
    }));

    renderPage([
      previewMock(),
      {
        request: {
          query: CONNECT_TELEGRAM_CHANNEL,
          variables: {
            token: "challenge-secret",
            projectId: "project-3",
          },
        },
        result: connectResult,
      },
    ]);

    await chooseProject("Telemetry Lab");
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Telegram" }),
    );

    await waitFor(() => expect(connectResult).toHaveBeenCalledOnce());
    expect(setActiveOrgId).toHaveBeenCalledWith("org-2");
    expect(push).toHaveBeenCalledWith("/channels?projectId=project-3");
  });

  it("evicts the exact stale channels list before navigating after success", async () => {
    const cache = new InMemoryCache();
    const channelsVariables = { projectId: "project-1" };
    cache.writeQuery({
      query: CHANNELS,
      variables: channelsVariables,
      data: {
        channels: [
          {
            id: "stale-channel",
            type: "EMAIL",
            configJson: '{"email":"stale@example.com"}',
            enabled: true,
            verificationStatus: "VERIFIED",
            verificationDeliveryStatus: "NOT_REQUIRED",
            verificationExpiresAt: null,
          },
        ],
      },
    });
    expect(
      cache.readQuery({ query: CHANNELS, variables: channelsVariables }),
    ).not.toBeNull();

    let channelsAtNavigation: unknown = "navigation-not-called";
    push.mockImplementation(() => {
      channelsAtNavigation = cache.readQuery({
        query: CHANNELS,
        variables: channelsVariables,
      });
    });

    renderPage(
      [
        previewMock(),
        {
          request: {
            query: CONNECT_TELEGRAM_CHANNEL,
            variables: {
              token: challengeToken,
              projectId: "project-1",
            },
          },
          result: {
            data: {
              connectTelegramChannel: {
                id: "channel-1",
                type: "TELEGRAM",
                configJson: "{}",
                enabled: true,
                projectId: "project-1",
              },
            },
          },
        },
      ],
      cache,
    );

    await screen.findByText("Incident Command");
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Telegram" }),
    );

    await waitFor(() => {
      expect(push).toHaveBeenCalledWith("/channels?projectId=project-1");
    });
    expect(channelsAtNavigation).toBeNull();
  });

  it.each([
    [
      "Connection challenge expired",
      "This connection link has expired",
      "Request a new connection link",
    ],
    [
      "This Telegram connection link has already been used",
      "This connection link was already used",
      "Request a new connection link",
    ],
    [
      "Managed Telegram bot unavailable",
      "Telegram connection is unavailable",
      "Try again later",
    ],
  ])(
    "maps preview error %s to a clear recovery state",
    async (message, heading, recovery) => {
      renderPage([
        previewMock({
          errors: [new GraphQLError(message)],
        }),
      ]);

      expect(
        await screen.findByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(screen.getByText(new RegExp(recovery, "i"))).toBeInTheDocument();
      expect(screen.queryByText(message)).not.toBeInTheDocument();
    },
  );

  it("maps a duplicate destination mutation to a recovery dialog", async () => {
    renderPage([
      previewMock(),
      {
        request: {
          query: CONNECT_TELEGRAM_CHANNEL,
          variables: {
            token: "challenge-secret",
            projectId: "project-1",
          },
        },
        result: {
          errors: [
            new GraphQLError("Telegram destination already connected"),
          ],
        },
      },
    ]);

    await screen.findByText("Incident Command");
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Telegram" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(
        "This Telegram destination is already connected",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/choose another project/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByText(/telegram destination already connected/i),
    ).not.toBeInTheDocument();
  });

  it.each([
    "Project not found",
    "Not a member of this organization",
  ])(
    "keeps the challenge usable when project access fails with %s",
    async (message) => {
      renderPage([
        previewMock(),
        {
          request: {
            query: CONNECT_TELEGRAM_CHANNEL,
            variables: {
              token: challengeToken,
              projectId: "project-1",
            },
          },
          result: {
            errors: [new GraphQLError(message)],
          },
        },
      ]);

      await screen.findByText("Incident Command");
      fireEvent.click(
        screen.getByRole("button", { name: "Connect Telegram" }),
      );

      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByText("Project access changed"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText(/choose another accessible project/i),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", {
          name: "Choose another project",
        }),
      ).toBeInTheDocument();
      expect(dialog).not.toHaveTextContent(/request a new connection link/i);
    },
  );

  it("never invokes native browser modals", async () => {
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    const confirm = vi
      .spyOn(window, "confirm")
      .mockImplementation(() => false);
    const prompt = vi.spyOn(window, "prompt").mockImplementation(() => null);

    renderPage([
      previewMock(),
      {
        request: {
          query: CONNECT_TELEGRAM_CHANNEL,
          variables: {
            token: "challenge-secret",
            projectId: "project-1",
          },
        },
        result: {
          errors: [new GraphQLError("Telegram destination already connected")],
        },
      },
    ]);

    await screen.findByText("Incident Command");
    fireEvent.click(
      screen.getByRole("button", { name: "Connect Telegram" }),
    );
    await screen.findByRole("dialog");

    expect(alert).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not disclose the bearer token through browser-visible sinks", async () => {
    challengeToken = "bearer-secret-never-disclose";
    searchParams = new URLSearchParams({ token: challengeToken });
    window.history.replaceState(
      {},
      "",
      `/channels/telegram/connect?token=${challengeToken}`,
    );
    const loggers = [
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
    ];

    const { container } = renderPage([
      previewMock({
        errors: [
          new GraphQLError(`Sensitive upstream failure: ${challengeToken}`),
        ],
      }),
    ]);

    await screen.findByRole("heading", {
      name: "Telegram connection is unavailable",
    });
    fireEvent.click(screen.getByRole("button", { name: "Return to channels" }));

    expect(container.innerHTML).not.toContain(challengeToken);
    expect(window.location.href).not.toContain(challengeToken);
    expect(
      Array.from({ length: localStorage.length }, (_, index) => {
        const key = localStorage.key(index) ?? "";
        return `${key}:${localStorage.getItem(key) ?? ""}`;
      }).join("\n"),
    ).not.toContain(challengeToken);
    expect(JSON.stringify(push.mock.calls)).not.toContain(challengeToken);

    for (const logger of loggers) {
      const logged = logger.mock.calls
        .flat()
        .map((value) => {
          if (value instanceof Error) {
            return `${value.name} ${value.message} ${value.stack ?? ""}`;
          }
          if (typeof value === "string") return value;
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })
        .join("\n");
      expect(logged).not.toContain(challengeToken);
    }
  });
});

describe("Telegram connection route metadata", () => {
  it("prevents the challenge URL from being sent as a referrer", () => {
    expect(metadata.referrer).toBe("no-referrer");
  });
});
