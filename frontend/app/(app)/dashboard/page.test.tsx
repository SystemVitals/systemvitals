import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { print } from "graphql";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHANNELS,
  CHECKS,
  MY_SUBSCRIPTION,
  PAUSE_CHECK,
  RESUME_CHECK,
  SET_CHECK_CHANNEL_ENABLED,
} from "@/lib/queries";
import { CHECK_POLL_INTERVAL_MS } from "@/lib/polling";
import DashboardPage from "./page";

const context = vi.hoisted(() => ({
  activeOrg: {
    id: "org-signal",
    name: "Signal org",
    slug: "signal-org",
    role: "MEMBER",
    plan: "SIGNAL",
    creatorUserId: "creator",
    creatorLabel: "creator@example.com",
    projects: [{ id: "project-signal", name: "App", slug: "app", pingKey: "key" }],
  },
  pollWhenVisible: vi.fn(),
}));

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "collaborator" } }),
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    activeOrg: context.activeOrg,
    orgs: [context.activeOrg],
  }),
}));

vi.mock("@/lib/use-poll-when-visible", () => ({
  usePollWhenVisible: context.pollWhenVisible,
}));

vi.mock("@/components/app/connect-agent-dialog", () => ({
  ConnectAgentDialog: () => null,
}));

vi.mock("@/components/ui/slider", () => ({
  Slider: ({ id, min }: { id?: string; min?: number }) => (
    <div id={id} data-min={min} />
  ),
}));

const checksMock = {
  request: {
    query: CHECKS,
    variables: { projectId: "project-signal" },
  },
  result: { data: { checks: [] } },
};

const channelsMock = {
  request: {
    query: CHANNELS,
    variables: { projectId: "project-signal" },
  },
  result: { data: { channels: [] } },
};

function subscriptionMock(plan: "SOLO" | "SIGNAL") {
  return {
    request: { query: MY_SUBSCRIPTION },
    result: {
      data: {
        mySubscription: {
          plan,
          status: "active",
          checkCount: 0,
          maxChecks: plan === "SOLO" ? 5 : 100,
          organizationCount: 1,
        },
      },
    },
  };
}

function renderDashboard(
  viewerPlan: "SOLO" | "SIGNAL",
  mocks: React.ComponentProps<typeof MockedProvider>["mocks"] = [
    checksMock,
    channelsMock,
    subscriptionMock(viewerPlan),
  ],
) {
  render(
    <MockedProvider mocks={mocks}>
      <DashboardPage />
    </MockedProvider>
  );
}

function check({
  id,
  name,
  status = "UP",
  notificationChannelIds = [],
}: {
  id: string;
  name: string;
  status?: "UP" | "PAUSED";
  notificationChannelIds?: string[];
}) {
  return {
    __typename: "CheckModel",
    id,
    name,
    slug: id,
    type: "HTTP",
    status,
    pingSlug: null,
    periodSeconds: null,
    intervalSeconds: 60,
    graceSeconds: 0,
    schedule: null,
    tz: null,
    nextExpectedAt: null,
    lastEventAt: "2026-07-28T12:00:00.000Z",
    notificationChannelIds,
  };
}

const enabledChannels = [
  {
    __typename: "NotificationChannelModel",
    id: "email",
    type: "EMAIL",
    configJson: '{"email":"alerts@example.com"}',
    enabled: true,
    verificationStatus: "VERIFIED",
    verificationDeliveryStatus: "DELIVERED",
    verificationExpiresAt: null,
  },
  {
    __typename: "NotificationChannelModel",
    id: "webhook",
    type: "WEBHOOK",
    configJson: '{"url":"https://hooks.example.com/private-token"}',
    enabled: true,
    verificationStatus: "NOT_REQUIRED",
    verificationDeliveryStatus: "NOT_REQUIRED",
    verificationExpiresAt: null,
  },
  {
    __typename: "NotificationChannelModel",
    id: "telegram-disabled",
    type: "TELEGRAM",
    configJson: '{"chatTitle":"Disabled room"}',
    enabled: false,
    verificationStatus: "NOT_REQUIRED",
    verificationDeliveryStatus: "NOT_REQUIRED",
    verificationExpiresAt: null,
  },
];

describe("DashboardPage", () => {
  beforeEach(() => {
    context.activeOrg.plan = "SIGNAL";
    context.pollWhenVisible.mockClear();
  });

  it("requests notification channel selections with checks", () => {
    expect(print(CHECKS)).toContain("notificationChannelIds");
  });

  it("uses the SIGNAL creator floor when a SOLO collaborator creates a check", async () => {
    context.activeOrg.plan = "SIGNAL";
    renderDashboard("SOLO");

    const newCheckButtons = await screen.findAllByRole("button", {
      name: /new check/i,
    });
    fireEvent.click(newCheckButtons[0]);

    await waitFor(() =>
      expect(document.getElementById("check-period")).toHaveAttribute("data-min", "60")
    );
  });

  it("uses the SOLO creator floor when a SIGNAL collaborator creates a check", async () => {
    context.activeOrg.plan = "SOLO";
    renderDashboard("SIGNAL");

    const newCheckButtons = await screen.findAllByRole("button", {
      name: /new check/i,
    });
    fireEvent.click(newCheckButtons[0]);

    await waitFor(() =>
      expect(document.getElementById("check-period")).toHaveAttribute("data-min", "300")
    );
  });

  it("loads channels once and gives every card the same enabled channel options", async () => {
    const channelsResult = vi.fn(() => ({
      data: { channels: enabledChannels },
    }));
    const dashboardChecks = [
      check({
        id: "api",
        name: "API",
        notificationChannelIds: ["email"],
      }),
      check({
        id: "worker",
        name: "Worker",
        notificationChannelIds: ["email"],
      }),
    ];

    renderDashboard("SIGNAL", [
      {
        request: {
          query: CHECKS,
          variables: { projectId: "project-signal" },
        },
        result: { data: { checks: dashboardChecks } },
      },
      {
        request: {
          query: CHANNELS,
          variables: { projectId: "project-signal" },
        },
        result: channelsResult,
      },
      subscriptionMock("SIGNAL"),
    ]);

    expect(
      await screen.findByRole("switch", { name: /API.*Email notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Worker.*Email notifications/i }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: /API.*Webhook notifications/i }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("switch", { name: /Worker.*Webhook notifications/i }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("switch", { name: /Telegram notifications/i }),
    ).not.toBeInTheDocument();
    expect(channelsResult).toHaveBeenCalledTimes(1);
  });

  it("keeps compact toggles independent and targets the correct check", async () => {
    const apiMutation = vi.fn(() => ({
      data: {
        setCheckChannelEnabled: {
          __typename: "CheckModel",
          id: "api",
          notificationChannelIds: [],
        },
      },
    }));
    const workerMutation = vi.fn(() => ({
      data: {
        setCheckChannelEnabled: {
          __typename: "CheckModel",
          id: "worker",
          notificationChannelIds: ["email", "webhook"],
        },
      },
    }));

    renderDashboard("SIGNAL", [
      {
        request: {
          query: CHECKS,
          variables: { projectId: "project-signal" },
        },
        result: {
          data: {
            checks: [
              check({
                id: "api",
                name: "API",
                notificationChannelIds: ["email"],
              }),
              check({
                id: "worker",
                name: "Worker",
                notificationChannelIds: ["email"],
              }),
            ],
          },
        },
      },
      {
        request: {
          query: CHANNELS,
          variables: { projectId: "project-signal" },
        },
        result: { data: { channels: enabledChannels } },
      },
      {
        request: {
          query: SET_CHECK_CHANNEL_ENABLED,
          variables: {
            checkId: "api",
            channelId: "email",
            enabled: false,
          },
        },
        result: apiMutation,
      },
      {
        request: {
          query: SET_CHECK_CHANNEL_ENABLED,
          variables: {
            checkId: "worker",
            channelId: "webhook",
            enabled: true,
          },
        },
        result: workerMutation,
      },
      subscriptionMock("SIGNAL"),
    ]);

    const apiEmail = await screen.findByRole("switch", {
      name: /API.*Email notifications/i,
    });
    const workerEmail = screen.getByRole("switch", {
      name: /Worker.*Email notifications/i,
    });
    const apiWebhook = screen.getByRole("switch", {
      name: /API.*Webhook notifications/i,
    });
    const workerWebhook = screen.getByRole("switch", {
      name: /Worker.*Webhook notifications/i,
    });

    fireEvent.click(apiEmail);
    fireEvent.click(workerWebhook);

    await waitFor(() => {
      expect(apiMutation).toHaveBeenCalledTimes(1);
      expect(workerMutation).toHaveBeenCalledTimes(1);
      expect(apiEmail).not.toBeChecked();
      expect(workerEmail).toBeChecked();
      expect(apiWebhook).not.toBeChecked();
      expect(workerWebhook).toBeChecked();
    });
  });

  it("shows the all-off notification warning for the affected check", async () => {
    renderDashboard("SIGNAL", [
      {
        request: {
          query: CHECKS,
          variables: { projectId: "project-signal" },
        },
        result: {
          data: {
            checks: [
              check({
                id: "silent",
                name: "Silent check",
                notificationChannelIds: [],
              }),
            ],
          },
        },
      },
      {
        request: {
          query: CHANNELS,
          variables: { projectId: "project-signal" },
        },
        result: { data: { channels: enabledChannels } },
      },
      subscriptionMock("SIGNAL"),
    ]);

    expect(await screen.findByText(/Notifications off/)).toHaveTextContent(
      "Notifications off",
    );
  });

  it("keeps checks on the shared 15-second visible-tab polling interval", async () => {
    renderDashboard("SIGNAL");

    await screen.findByText("No checks yet. Start monitoring your first service.");
    expect(context.pollWhenVisible).toHaveBeenCalled();
    for (const [query, interval] of context.pollWhenVisible.mock.calls) {
      expect(query).toEqual(
        expect.objectContaining({
          startPolling: expect.any(Function),
          stopPolling: expect.any(Function),
        }),
      );
      expect(interval).toBe(CHECK_POLL_INTERVAL_MS);
    }
    expect(CHECK_POLL_INTERVAL_MS).toBe(15_000);
  });

  it("preserves pause and resume actions", async () => {
    const pauseResult = vi.fn(() => ({
      data: { pauseCheck: { __typename: "CheckModel", id: "api", status: "PAUSED" } },
    }));
    const resumeResult = vi.fn(() => ({
      data: { resumeCheck: { __typename: "CheckModel", id: "worker", status: "UP" } },
    }));
    const checks = [
      check({ id: "api", name: "API", status: "UP" }),
      check({ id: "worker", name: "Worker", status: "PAUSED" }),
    ];

    renderDashboard("SIGNAL", [
      {
        request: {
          query: CHECKS,
          variables: { projectId: "project-signal" },
        },
        result: { data: { checks } },
        maxUsageCount: 3,
      },
      {
        request: {
          query: CHANNELS,
          variables: { projectId: "project-signal" },
        },
        result: { data: { channels: [] } },
      },
      {
        request: {
          query: PAUSE_CHECK,
          variables: { id: "api" },
        },
        result: pauseResult,
      },
      {
        request: {
          query: RESUME_CHECK,
          variables: { id: "worker" },
        },
        result: resumeResult,
      },
      subscriptionMock("SIGNAL"),
    ]);

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => {
      expect(pauseResult).toHaveBeenCalledTimes(1);
      expect(resumeResult).toHaveBeenCalledTimes(1);
    });
  });
});
