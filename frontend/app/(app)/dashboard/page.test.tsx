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
    pingKey: "key",
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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/components/ui/slider", () => ({
  Slider: ({ id, min }: { id?: string; min?: number }) => (
    <div id={id} data-min={min} />
  ),
}));

const checksMock = {
  request: {
    query: CHECKS,
    variables: { organizationId: "org-signal" },
  },
  result: {
    data: {
      checks: [],
      organizationCheckAllowance: {
        __typename: "OrganizationCheckAllowance",
        used: 2,
        limit: 5,
        remaining: 3,
      },
    },
  },
};

const channelsMock = {
  request: {
    query: CHANNELS,
    variables: { organizationId: "org-signal" },
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
  return render(
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
    Object.assign(context.activeOrg, {
      id: "org-signal",
      name: "Signal org",
      slug: "signal-org",
      role: "MEMBER",
      plan: "SIGNAL",
      creatorUserId: "creator",
      creatorLabel: "creator@example.com",
      pingKey: "key",
    });
    context.pollWhenVisible.mockClear();
  });

  it("requests notification channel selections with checks", () => {
    expect(print(CHECKS)).toContain("notificationChannelIds");
  });

  it("requests and prominently shows the active organization's check allowance", async () => {
    expect(print(CHECKS)).toContain(
      "organizationCheckAllowance(organizationId: $organizationId)",
    );
    expect(print(CHECKS)).toContain("remaining");

    renderDashboard("SIGNAL");

    const allowance = await screen.findByRole("status", {
      name: "Check allowance",
    });
    expect(allowance).toHaveTextContent("3 checks left");
    expect(allowance).toHaveTextContent("2 of 5 used");

    fireEvent.click(
      (await screen.findAllByRole("button", { name: /new check/i }))[0],
    );
    expect(
      await screen.findByText("3 checks left on this plan."),
    ).toBeInTheDocument();
  });

  it("makes an exhausted check allowance explicit and prevents opening creation", async () => {
    renderDashboard("SOLO", [
      {
        request: {
          query: CHECKS,
          variables: { organizationId: "org-signal" },
        },
        result: {
          data: {
            checks: [],
            organizationCheckAllowance: {
              __typename: "OrganizationCheckAllowance",
              used: 5,
              limit: 5,
              remaining: 0,
            },
          },
        },
      },
      channelsMock,
      subscriptionMock("SOLO"),
    ]);

    const allowance = await screen.findByRole("status", {
      name: "Check allowance",
    });
    expect(allowance).toHaveTextContent("0 checks left");
    expect(allowance).toHaveTextContent("Limit reached");

    const creationButtons = screen.getAllByRole("button", {
      name: /new check/i,
    });
    expect(creationButtons).toHaveLength(2);
    for (const button of creationButtons) {
      expect(button).toBeDisabled();
    }
    expect(
      screen.queryByRole("dialog", { name: "New check" }),
    ).not.toBeInTheDocument();
  });

  it("restores Connect agent entry points for the active organization", async () => {
    renderDashboard("SIGNAL");

    await screen.findByText("No checks yet. Start monitoring your first service.");
    const entryPoints = screen.getAllByRole("button", {
      name: "Connect agent",
    });
    expect(entryPoints).toHaveLength(2);

    fireEvent.click(entryPoints[0]);
    const dialog = await screen.findByRole("dialog", {
      name: "Connect agent",
    });
    expect(dialog).toHaveTextContent(
      "Create an organization-scoped connection for Signal org.",
    );
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
          variables: { organizationId: "org-signal" },
        },
        result: { data: { checks: dashboardChecks } },
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-signal" },
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
    expect(screen.getByRole("link", { name: "API" })).toHaveAttribute(
      "href",
      "/signal-org/api",
    );
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(screen.queryByText("App")).not.toBeInTheDocument();
  });

  it("reloads checks and notification channels when the active organization changes", async () => {
    const mocks = [
      {
        request: {
          query: CHECKS,
          variables: { organizationId: "org-signal" },
        },
        result: {
          data: { checks: [check({ id: "signal-api", name: "Signal API" })] },
        },
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-signal" },
        },
        result: { data: { channels: [] } },
      },
      {
        request: {
          query: CHECKS,
          variables: { organizationId: "org-beta" },
        },
        result: {
          data: { checks: [check({ id: "beta-api", name: "Beta API" })] },
        },
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-beta" },
        },
        result: { data: { channels: [] } },
      },
      subscriptionMock("SIGNAL"),
    ];
    const view = renderDashboard("SIGNAL", mocks);

    expect(await screen.findByRole("link", { name: "Signal API" })).toHaveAttribute(
      "href",
      "/signal-org/signal-api",
    );

    Object.assign(context.activeOrg, {
      id: "org-beta",
      name: "Beta",
      slug: "beta",
      pingKey: "beta-key",
    });
    view.rerender(
      <MockedProvider mocks={mocks}>
        <DashboardPage />
      </MockedProvider>,
    );

    expect(await screen.findByRole("link", { name: "Beta API" })).toHaveAttribute(
      "href",
      "/beta/beta-api",
    );
  });

  it("shows a neutral channel loading state without false empty or all-off messaging", async () => {
    renderDashboard("SIGNAL", [
      {
        request: {
          query: CHECKS,
          variables: { organizationId: "org-signal" },
        },
        result: {
          data: {
            checks: [
              check({
                id: "api",
                name: "API",
                notificationChannelIds: [],
              }),
            ],
          },
        },
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-signal" },
        },
        delay: 150,
        result: { data: { channels: enabledChannels } },
      },
      subscriptionMock("SIGNAL"),
    ]);

    await screen.findByRole("link", { name: "API" });
    expect(
      screen.getByRole("status", { name: "Loading notification channels" }),
    ).toHaveTextContent("Loading notification channels…");
    expect(
      screen.queryByText("No active notification channels"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Notifications off/)).not.toBeInTheDocument();

    expect(
      await screen.findByRole("switch", {
        name: /API.*Email notifications/i,
      }),
    ).not.toBeChecked();
  });

  it("shows a channel loading error dialog and retries the channel query", async () => {
    const successfulRetry = vi.fn(() => ({
      data: { channels: enabledChannels },
    }));

    renderDashboard("SIGNAL", [
      {
        request: {
          query: CHECKS,
          variables: { organizationId: "org-signal" },
        },
        result: {
          data: {
            checks: [
              check({
                id: "api",
                name: "API",
                notificationChannelIds: ["email"],
              }),
            ],
          },
        },
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-signal" },
        },
        error: new Error("network unavailable"),
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-signal" },
        },
        result: successfulRetry,
      },
      subscriptionMock("SIGNAL"),
    ]);

    const dialog = await screen.findByRole("dialog", {
      name: "Notification channels unavailable",
    });
    expect(dialog).toHaveTextContent(
      "Could not load notification channels. Please try again.",
    );
    expect(
      screen.getByRole("status", {
        name: "Notification channels unavailable",
        hidden: true,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("No active notification channels"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Notifications off/)).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry notification channels" }),
    );

    expect(
      await screen.findByRole("switch", {
        name: /API.*Email notifications/i,
      }),
    ).toBeChecked();
    expect(successfulRetry).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", {
          name: "Notification channels unavailable",
        }),
      ).not.toBeInTheDocument(),
    );
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
          variables: { organizationId: "org-signal" },
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
          variables: { organizationId: "org-signal" },
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
          variables: { organizationId: "org-signal" },
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
          variables: { organizationId: "org-signal" },
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
          variables: { organizationId: "org-signal" },
        },
        result: { data: { checks } },
        maxUsageCount: 3,
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-signal" },
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
