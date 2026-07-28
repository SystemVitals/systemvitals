import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { InMemoryCache } from "@apollo/client";
import type { MockedResponse } from "@apollo/client/testing";
import { MockedProvider } from "@apollo/client/testing/react";
import { GraphQLError } from "graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNELS,
  CREATE_CHANNEL,
  DELETE_CHANNEL,
  MANAGED_TELEGRAM_BOT,
  RESEND_EMAIL_CHANNEL_VERIFICATION,
} from "@/lib/queries";
import ChannelsPage, { resolveChannelsProject } from "./page";

let requestedProjectId: string | null = null;
let mockUser: { id: string; email: string } | null = {
  id: "user-1",
  email: "ops@example.com",
};
let mockActiveOrg: {
  id: string;
  projects: { id: string; name: string }[];
} | null = {
  id: "org-1",
  projects: [
    { id: "project-1", name: "Production" },
    { id: "project-2", name: "Staging" },
  ],
};

vi.mock("next/navigation", () => ({
  useSearchParams: () => {
    const params = new URLSearchParams();
    if (requestedProjectId !== null) {
      params.set("projectId", requestedProjectId);
    }
    return params;
  },
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: mockUser }),
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ activeOrg: mockActiveOrg }),
}));

const managedBotMock = {
  request: { query: MANAGED_TELEGRAM_BOT },
  result: {
    data: {
      managedTelegramBot: {
        available: true,
        username: "VitalsRelayBot",
      },
    },
  },
  maxUsageCount: 20,
};

function channelsMock(
  projectId: string,
  channels: Array<{
    id: string;
    type: string;
    configJson: string;
    enabled: boolean;
    verificationStatus?: string;
    verificationDeliveryStatus?: string;
    verificationExpiresAt?: string | null;
  }> = []
) {
  return {
    request: {
      query: CHANNELS,
      variables: { projectId },
    },
    result: {
      data: { channels },
    },
    maxUsageCount: 2,
  };
}

function renderPage(mocks: MockedResponse[] = []) {
  return render(
    <MockedProvider mocks={mocks}>
      <ChannelsPage />
    </MockedProvider>
  );
}

function listenForUnhandledRejections() {
  const listener = vi.fn((event: PromiseRejectionEvent) => {
    event.preventDefault();
  });
  window.addEventListener("unhandledrejection", listener);
  return {
    listener,
    stop: () => window.removeEventListener("unhandledrejection", listener),
  };
}

describe("resolveChannelsProject", () => {
  const projects = [
    { id: "project-1", name: "Production" },
    { id: "project-2", name: "Staging" },
  ];

  it("accepts an owned requested project", () => {
    expect(resolveChannelsProject("project-2", projects)).toBe("project-2");
  });

  it("rejects a hostile or foreign requested project", () => {
    expect(resolveChannelsProject("../../admin", projects)).toBe("project-1");
    expect(resolveChannelsProject("foreign-project", projects)).toBe(
      "project-1"
    );
  });

  it("falls back to the first project when no project was requested", () => {
    expect(resolveChannelsProject(null, projects)).toBe("project-1");
  });

  it("returns null when the active organization has no projects", () => {
    expect(resolveChannelsProject("foreign-project", [])).toBeNull();
  });
});

describe("ChannelsPage", () => {
  beforeEach(() => {
    requestedProjectId = null;
    mockUser = { id: "user-1", email: "ops@example.com" };
    mockActiveOrg = {
      id: "org-1",
      projects: [
        { id: "project-1", name: "Production" },
        { id: "project-2", name: "Staging" },
      ],
    };
  });

  it("renders managed setup with sanitized Telegram summaries and mode badges", async () => {
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "legacy-channel",
          type: "TELEGRAM",
          configJson:
            '{"mode":"LEGACY","chatTitle":" Ops Room ","chatId":"-100","messageThreadId":42}',
          enabled: true,
        },
        {
          id: "managed-channel",
          type: "TELEGRAM",
          configJson:
            '{"mode":"MANAGED","chatTitle":" ","chatId":" -200 ","messageThreadId":7}',
          enabled: true,
        },
        {
          id: "unknown-channel",
          type: "TELEGRAM",
          configJson:
            '{"mode":"FUTURE","chatTitle":"Broadcasts","messageThreadId":"9"}',
          enabled: false,
        },
      ]),
    ]);

    expect(await screen.findByText("@VitalsRelayBot")).toBeInTheDocument();
    expect(screen.getByText("Ops Room · topic: 42")).toBeInTheDocument();
    expect(screen.getByText("-200 · topic: 7")).toBeInTheDocument();
    expect(screen.getByText("Broadcasts")).toBeInTheDocument();
    expect(screen.getByText("Legacy custom bot")).toBeInTheDocument();
    expect(screen.getByText("SystemVitals bot")).toBeInTheDocument();
    expect(screen.getAllByText("Legacy custom bot")).toHaveLength(1);
    expect(screen.getAllByText("SystemVitals bot")).toHaveLength(1);
  });

  it("keeps existing Telegram channels deletable with a confirmation dialog", async () => {
    const deleteResult = vi.fn(() => ({
      data: { deleteChannel: true },
    }));
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "legacy-channel",
          type: "TELEGRAM",
          configJson:
            '{"mode":"LEGACY","chatTitle":"Ops Room","messageThreadId":42}',
          enabled: true,
        },
      ]),
      {
        request: {
          query: DELETE_CHANNEL,
          variables: { id: "legacy-channel" },
        },
        result: deleteResult,
      },
    ]);

    fireEvent.click(
      await screen.findByRole("button", { name: /delete telegram channel/i })
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Delete channel?")).toBeInTheDocument();
    expect(dialog).toHaveAccessibleDescription(
      "This channel will no longer receive alerts. This action cannot be undone."
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(deleteResult).toHaveBeenCalledOnce());
  });

  it("offers only Email, Slack, and Webhook in the generic add form", async () => {
    renderPage([managedBotMock, channelsMock("project-1")]);

    expect(
      await screen.findByRole("textbox", { name: "Email address" })
    ).toBeInTheDocument();
    const select = screen.getByRole("combobox", { name: "Channel type" });
    expect(select).toHaveTextContent("Email");

    fireEvent.click(select);

    expect(await screen.findByRole("option", { name: "Email" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Slack" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Webhook" })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "Telegram" })
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/getupdates|chat\.id|message_thread_id/i)).not.toBeInTheDocument();
  });

  it("does not render Telegram credential or destination ID controls", async () => {
    renderPage([managedBotMock, channelsMock("project-1")]);

    await screen.findByText("@VitalsRelayBot");

    const forbiddenName = /token|bot token|chat id|group id|topic id/i;
    const controls = [
      ...screen.getAllByRole("textbox"),
      ...screen.queryAllByRole("spinbutton"),
      ...screen.getAllByRole("combobox"),
    ];
    for (const control of controls) {
      expect(control).not.toHaveAccessibleName(forbiddenName);
    }
  });

  it("uses an owned project from the search params for channel queries and creates", async () => {
    requestedProjectId = "project-2";
    const createResult = vi.fn(() => ({
      data: {
        createChannel: {
          id: "email-channel",
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:00:00.000Z",
        },
      },
    }));
    renderPage([
      managedBotMock,
      channelsMock("project-2"),
      {
        request: {
          query: CREATE_CHANNEL,
          variables: {
            projectId: "project-2",
            type: "EMAIL",
            configJson: '{"email":"alerts@example.com"}',
          },
        },
        result: createResult,
      },
    ]);

    const email = await screen.findByRole("textbox", {
      name: "Email address",
    });
    fireEvent.change(email, { target: { value: "alerts@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(createResult).toHaveBeenCalledOnce());
  });

  it("explains that a newly created email is inactive until verified", async () => {
    renderPage([
      managedBotMock,
      channelsMock("project-1"),
      {
        request: {
          query: CREATE_CHANNEL,
          variables: {
            projectId: "project-1",
            type: "EMAIL",
            configJson: '{"email":"alerts@example.com"}',
          },
        },
        result: {
          data: {
            createChannel: {
              id: "email-channel",
              enabled: false,
              verificationStatus: "PENDING",
              verificationDeliveryStatus: "SENT",
              verificationExpiresAt: "2026-07-28T12:00:00.000Z",
            },
          },
        },
      },
    ]);

    fireEvent.change(
      await screen.findByRole("textbox", { name: "Email address" }),
      { target: { value: "alerts@example.com" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    const status = (
      await screen.findByText(/Verification email sent/)
    ).closest('[role="status"]');
    expect(status).not.toBeNull();
    expect(status).toHaveTextContent("Verification email sent");
    expect(status).toHaveTextContent("inactive until verified");
  });

  it("keeps the newly returned pending row usable when reconciliation fails", async () => {
    const unhandled = listenForUnhandledRejections();
    const resendResult = vi.fn(() => ({
      data: {
        resendEmailChannelVerification: {
          id: "new-channel",
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:01:00.000Z",
        },
      },
    }));
    try {
      renderPage([
        managedBotMock,
        {
          request: {
            query: CHANNELS,
            variables: { projectId: "project-1" },
          },
          result: { data: { channels: [] } },
        },
        {
          request: {
            query: CHANNELS,
            variables: { projectId: "project-1" },
          },
          error: new Error("Channel reconciliation unavailable"),
        },
        {
          request: {
            query: CREATE_CHANNEL,
            variables: {
              projectId: "project-1",
              type: "EMAIL",
              configJson: '{"email":"new@example.com"}',
            },
          },
          result: {
            data: {
              createChannel: {
                id: "new-channel",
                enabled: false,
                verificationStatus: "PENDING",
                verificationDeliveryStatus: "NOT_SENT",
                verificationExpiresAt: "2026-07-28T12:00:00.000Z",
              },
            },
          },
        },
        {
          request: {
            query: RESEND_EMAIL_CHANNEL_VERIFICATION,
            variables: { channelId: "new-channel" },
          },
          result: resendResult,
        },
      ]);

      fireEvent.change(
        await screen.findByRole("textbox", { name: "Email address" }),
        { target: { value: "new@example.com" } }
      );
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      expect(
        await screen.findByText(/Verification could not be sent/)
      ).toBeInTheDocument();
      const newRow = screen
        .getByText("new@example.com")
        .closest<HTMLElement>("[data-channel-row]");
      expect(newRow).not.toBeNull();
      expect(within(newRow!).getByText("Verification pending")).toBeInTheDocument();

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAccessibleDescription(
        "Channel reconciliation unavailable"
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
      fireEvent.click(
        screen.getByRole("button", {
          name: "Resend verification to new@example.com",
        })
      );

      await waitFor(() => expect(resendResult).toHaveBeenCalledOnce());
      await waitFor(() => expect(unhandled.listener).not.toHaveBeenCalled());
    } finally {
      unhandled.stop();
    }
  });

  it("reconciles a created channel without duplicates or order changes", async () => {
    const existingChannel = {
      id: "existing-channel",
      type: "EMAIL",
      configJson: '{"email":"existing@example.com"}',
      enabled: true,
      verificationStatus: "VERIFIED",
      verificationDeliveryStatus: "NOT_REQUIRED",
      verificationExpiresAt: null,
    };
    const createdChannel = {
      id: "new-channel",
      type: "EMAIL",
      configJson: '{"email":"new@example.com"}',
      enabled: false,
      verificationStatus: "PENDING",
      verificationDeliveryStatus: "SENT",
      verificationExpiresAt: "2026-07-28T12:00:00.000Z",
    };
    renderPage([
      managedBotMock,
      {
        request: {
          query: CHANNELS,
          variables: { projectId: "project-1" },
        },
        result: { data: { channels: [existingChannel] } },
      },
      {
        request: {
          query: CHANNELS,
          variables: { projectId: "project-1" },
        },
        result: { data: { channels: [existingChannel, createdChannel] } },
      },
      {
        request: {
          query: CREATE_CHANNEL,
          variables: {
            projectId: "project-1",
            type: "EMAIL",
            configJson: '{"email":"new@example.com"}',
          },
        },
        result: {
          data: {
            createChannel: {
              id: "new-channel",
              enabled: false,
              verificationStatus: "PENDING",
              verificationDeliveryStatus: "NOT_SENT",
              verificationExpiresAt: "2026-07-28T12:00:00.000Z",
            },
          },
        },
      },
    ]);

    await screen.findByText("existing@example.com");
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Email address" }),
      { target: { value: "new@example.com" } }
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await screen.findByText("new@example.com");
    await waitFor(() => {
      const rows = document.querySelectorAll<HTMLElement>("[data-channel-row]");
      expect(rows).toHaveLength(2);
      expect(within(rows[0]).getByText("existing@example.com")).toBeInTheDocument();
      expect(within(rows[1]).getByText("new@example.com")).toBeInTheDocument();
    });
  });

  it("shows pending and verified email rows with the correct actions", async () => {
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "pending-channel",
          type: "EMAIL",
          configJson: '{"email":"pending@example.com"}',
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:00:00.000Z",
        },
        {
          id: "verified-channel",
          type: "EMAIL",
          configJson: '{"email":"verified@example.com"}',
          enabled: true,
          verificationStatus: "VERIFIED",
          verificationDeliveryStatus: "NOT_REQUIRED",
          verificationExpiresAt: null,
        },
      ]),
    ]);

    const pendingRow = (
      await screen.findByText("pending@example.com")
    ).closest<HTMLElement>("[data-channel-row]");
    const verifiedRow = screen
      .getByText("verified@example.com")
      .closest<HTMLElement>("[data-channel-row]");
    expect(pendingRow).not.toBeNull();
    expect(verifiedRow).not.toBeNull();
    expect(within(pendingRow!).getByText("Verification pending")).toBeInTheDocument();
    expect(within(pendingRow!).getByText(/Jul 28, 2026/)).toBeInTheDocument();
    expect(within(pendingRow!).queryByText("Active")).not.toBeInTheDocument();
    expect(
      within(pendingRow!).getByRole("button", { name: /resend verification/i })
    ).toBeInTheDocument();
    expect(within(verifiedRow!).getByText("Active")).toBeInTheDocument();
    expect(
      within(verifiedRow!).queryByRole("button", { name: /resend verification/i })
    ).not.toBeInTheDocument();
  });

  it("resends verification for the exact channel and announces success", async () => {
    const resendResult = vi.fn(() => ({
      data: {
        resendEmailChannelVerification: {
          id: "pending-channel",
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:01:00.000Z",
        },
      },
    }));
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "pending-channel",
          type: "EMAIL",
          configJson: '{"email":"pending@example.com"}',
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:00:00.000Z",
        },
      ]),
      {
        request: {
          query: RESEND_EMAIL_CHANNEL_VERIFICATION,
          variables: { channelId: "pending-channel" },
        },
        result: resendResult,
      },
    ]);

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Resend verification to pending@example.com",
      })
    );

    await waitFor(() => expect(resendResult).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Verification email sent"
    );
  });

  it("keeps the exact pending channel retryable when delivery is not sent", async () => {
    const firstResend = vi.fn(() => ({
      data: {
        resendEmailChannelVerification: {
          id: "pending-channel",
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "NOT_SENT",
          verificationExpiresAt: "2026-07-28T12:01:00.000Z",
        },
      },
    }));
    const secondResend = vi.fn(() => ({
      data: {
        resendEmailChannelVerification: {
          id: "pending-channel",
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:02:00.000Z",
        },
      },
    }));
    const resendRequest = {
      query: RESEND_EMAIL_CHANNEL_VERIFICATION,
      variables: { channelId: "pending-channel" },
    };
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "pending-channel",
          type: "EMAIL",
          configJson: '{"email":"pending@example.com"}',
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "NOT_SENT",
          verificationExpiresAt: "2026-07-28T12:00:00.000Z",
        },
      ]),
      { request: resendRequest, result: firstResend },
      { request: resendRequest, result: secondResend },
    ]);

    const resendButton = await screen.findByRole("button", {
      name: "Resend verification to pending@example.com",
    });
    fireEvent.click(resendButton);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription(
      "Verification could not be sent. Please try again."
    );
    expect(screen.queryByText("Verification email sent.")).not.toBeInTheDocument();
    expect(resendButton).toBeEnabled();
    expect(firstResend).toHaveBeenCalledOnce();

    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
    fireEvent.click(resendButton);

    await waitFor(() => expect(secondResend).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Verification email sent"
    );
  });

  it("handles missing resend mutation data as a recoverable failure", async () => {
    const unhandled = listenForUnhandledRejections();
    try {
      renderPage([
        managedBotMock,
        channelsMock("project-1", [
          {
            id: "pending-channel",
            type: "EMAIL",
            configJson: '{"email":"pending@example.com"}',
            enabled: false,
            verificationStatus: "PENDING",
            verificationDeliveryStatus: "NOT_SENT",
            verificationExpiresAt: "2026-07-28T12:00:00.000Z",
          },
        ]),
        {
          request: {
            query: RESEND_EMAIL_CHANNEL_VERIFICATION,
            variables: { channelId: "pending-channel" },
          },
          result: { data: {} },
        },
      ]);

      const resendButton = await screen.findByRole("button", {
        name: "Resend verification to pending@example.com",
      });
      fireEvent.click(resendButton);

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAccessibleDescription(
        "Verification could not be sent. Please try again."
      );
      expect(resendButton).toBeEnabled();
      await waitFor(() => expect(unhandled.listener).not.toHaveBeenCalled());
    } finally {
      unhandled.stop();
    }
  });

  it("contains resend cooldown rejection in the existing error dialog", async () => {
    const unhandled = listenForUnhandledRejections();
    try {
      renderPage([
        managedBotMock,
        channelsMock("project-1", [
          {
            id: "pending-channel",
            type: "EMAIL",
            configJson: '{"email":"pending@example.com"}',
            enabled: false,
            verificationStatus: "PENDING",
            verificationDeliveryStatus: "SENT",
            verificationExpiresAt: "2026-07-28T12:00:00.000Z",
          },
        ]),
        {
          request: {
            query: RESEND_EMAIL_CHANNEL_VERIFICATION,
            variables: { channelId: "pending-channel" },
          },
          result: {
            errors: [
              new GraphQLError(
                "Please wait 42 seconds before resending verification"
              ),
            ],
          },
        },
      ]);

      fireEvent.click(
        await screen.findByRole("button", {
          name: "Resend verification to pending@example.com",
        })
      );

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAccessibleDescription(
        "Please wait 42 seconds before resending verification"
      );
      await waitFor(() => expect(unhandled.listener).not.toHaveBeenCalled());
    } finally {
      unhandled.stop();
    }
  });

  it("leaves the non-email channel row layout and status unchanged", async () => {
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "slack-channel",
          type: "SLACK",
          configJson: '{"webhookUrl":"https://hooks.slack.com/services/a/b/c"}',
          enabled: true,
          verificationStatus: "NOT_REQUIRED",
          verificationDeliveryStatus: "NOT_REQUIRED",
          verificationExpiresAt: null,
        },
      ]),
    ]);

    const row = (
      await screen.findByText("https://hooks.slack.com/services/a/b/c")
    ).closest<HTMLElement>("[data-channel-row]");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("Slack")).toBeInTheDocument();
    expect(within(row!).getByText("Active")).toBeInTheDocument();
    expect(
      within(row!).queryByText("Verification pending")
    ).not.toBeInTheDocument();
    expect(
      within(row!).queryByRole("button", { name: /resend verification/i })
    ).not.toBeInTheDocument();
  });

  it("falls back to the first owned project for a foreign URL project", async () => {
    requestedProjectId = "project-from-another-org";
    renderPage([
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "owned-channel",
          type: "EMAIL",
          configJson: '{"email":"owned@example.com"}',
          enabled: true,
        },
      ]),
    ]);

    expect(await screen.findByText("owned@example.com")).toBeInTheDocument();
  });

  it("reacts to search parameter changes and selects the newly requested owned project", async () => {
    const mocks = [
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "production-channel",
          type: "EMAIL",
          configJson: '{"email":"production@example.com"}',
          enabled: true,
        },
      ]),
      channelsMock("project-2", [
        {
          id: "staging-channel",
          type: "EMAIL",
          configJson: '{"email":"staging@example.com"}',
          enabled: true,
        },
      ]),
    ];
    const { rerender } = renderPage(mocks);

    expect(await screen.findByText("production@example.com")).toBeInTheDocument();

    requestedProjectId = "project-2";
    rerender(
      <MockedProvider mocks={mocks}>
        <ChannelsPage />
      </MockedProvider>
    );

    expect(await screen.findByText("staging@example.com")).toBeInTheDocument();
  });

  it("resets project-scoped state when switching to another owned project", async () => {
    const deleteProjectA = vi.fn(() => ({
      data: { deleteChannel: true },
    }));
    const mocks: MockedResponse[] = [
      managedBotMock,
      channelsMock("project-1", [
        {
          id: "project-a-channel",
          type: "EMAIL",
          configJson: '{"email":"project-a@example.com"}',
          enabled: true,
        },
      ]),
      channelsMock("project-2", [
        {
          id: "project-b-channel",
          type: "EMAIL",
          configJson: '{"email":"project-b@example.com"}',
          enabled: true,
        },
      ]),
      {
        request: {
          query: DELETE_CHANNEL,
          variables: { id: "project-a-channel" },
        },
        result: deleteProjectA,
      },
    ];
    const { rerender } = renderPage(mocks);

    fireEvent.click(
      await screen.findByRole("button", {
        name: /delete email channel project-a@example\.com/i,
      })
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete channel?");

    requestedProjectId = "project-2";
    rerender(
      <MockedProvider mocks={mocks}>
        <ChannelsPage />
      </MockedProvider>
    );

    expect(await screen.findByText("project-b@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText("project-a@example.com")).not.toBeInTheDocument();
    expect(deleteProjectA).not.toHaveBeenCalled();
  });

  it("contains GraphQL create rejection and shows its error once", async () => {
    const unhandled = listenForUnhandledRejections();
    try {
      renderPage([
        managedBotMock,
        channelsMock("project-1"),
        {
          request: {
            query: CREATE_CHANNEL,
            variables: {
              projectId: "project-1",
              type: "EMAIL",
              configJson: '{"email":"alerts@example.com"}',
            },
          },
          result: {
            errors: [new GraphQLError("Channel creation rejected")],
          },
        },
      ]);

      fireEvent.change(
        await screen.findByRole("textbox", { name: "Email address" }),
        { target: { value: "alerts@example.com" } }
      );
      fireEvent.click(screen.getByRole("button", { name: "Add" }));

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toHaveAccessibleDescription("Channel creation rejected");
      expect(
        within(dialog).getAllByText("Channel creation rejected")
      ).toHaveLength(1);
      await waitFor(() => expect(unhandled.listener).not.toHaveBeenCalled());
    } finally {
      unhandled.stop();
    }
  });

  it("contains transport delete rejection and shows its error once", async () => {
    const unhandled = listenForUnhandledRejections();
    try {
      renderPage([
        managedBotMock,
        channelsMock("project-1", [
          {
            id: "failing-delete-channel",
            type: "EMAIL",
            configJson: '{"email":"delete-me@example.com"}',
            enabled: true,
          },
        ]),
        {
          request: {
            query: DELETE_CHANNEL,
            variables: { id: "failing-delete-channel" },
          },
          error: new Error("Channel service unavailable"),
        },
      ]);

      fireEvent.click(
        await screen.findByRole("button", {
          name: /delete email channel delete-me@example\.com/i,
        })
      );
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Delete",
        })
      );

      await screen.findByText("Channel service unavailable");
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveAccessibleDescription(
        "Channel service unavailable"
      );
      expect(
        within(dialog).getAllByText("Channel service unavailable")
      ).toHaveLength(1);
      expect(unhandled.listener).not.toHaveBeenCalled();
    } finally {
      unhandled.stop();
    }
  });

  it("requests managed bot recovery on every page mount instead of trusting cache", async () => {
    const cache = new InMemoryCache();
    cache.writeQuery({
      query: MANAGED_TELEGRAM_BOT,
      data: {
        managedTelegramBot: {
          available: false,
          username: null,
        },
      },
    });
    const managedResult = vi.fn(() => ({
      data: {
        managedTelegramBot: {
          available: true,
          username: "VitalsRelayBot",
        },
      },
    }));
    const mocks: MockedResponse[] = [
      {
        request: { query: MANAGED_TELEGRAM_BOT },
        result: managedResult,
      },
      channelsMock("project-1"),
    ];

    const firstMount = render(
      <MockedProvider mocks={mocks} cache={cache}>
        <ChannelsPage />
      </MockedProvider>
    );
    expect(await screen.findByText("@VitalsRelayBot")).toBeInTheDocument();
    firstMount.unmount();

    cache.writeQuery({
      query: MANAGED_TELEGRAM_BOT,
      data: {
        managedTelegramBot: {
          available: false,
          username: null,
        },
      },
    });
    render(
      <MockedProvider mocks={mocks} cache={cache}>
        <ChannelsPage />
      </MockedProvider>
    );

    expect(await screen.findByText("@VitalsRelayBot")).toBeInTheDocument();
    expect(managedResult).toHaveBeenCalledTimes(2);
  });

  it("announces managed Telegram setup while its network query is loading", async () => {
    renderPage([
      {
        request: { query: MANAGED_TELEGRAM_BOT },
        delay: Infinity,
      },
      channelsMock("project-1"),
    ]);

    expect(
      screen.getByRole("status", { name: "Loading Telegram setup" })
    ).toBeInTheDocument();
  });

  it("fails managed bot lookup closed without exposing query details", async () => {
    renderPage([
      {
        request: { query: MANAGED_TELEGRAM_BOT },
        error: new Error("sensitive upstream detail"),
      },
      channelsMock("project-1"),
    ]);

    expect(
      await screen.findByText(/telegram setup is temporarily unavailable/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/sensitive upstream detail/i)).not.toBeInTheDocument();
  });

  it("preserves the no-project state without issuing channel setup queries", () => {
    mockActiveOrg = { id: "org-1", projects: [] };

    renderPage();

    expect(screen.getByText("No projects found.")).toBeInTheDocument();
  });

  it("renders nothing without an authenticated user", () => {
    mockUser = null;

    const { container } = renderPage();

    expect(container).toBeEmptyDOMElement();
  });
});
