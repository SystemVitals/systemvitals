import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { GraphQLError, print } from "graphql";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import {
  CHANNELS,
  CHECK,
  SET_CHECK_CHANNEL_ENABLED,
} from "@/lib/queries";
import { CHECK_BY_SLUG } from "@/lib/legacy-queries";
import type { Org } from "@/lib/org-context";

const orgContext = vi.hoisted(() => ({
  orgs: [] as Org[],
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ activeOrg: orgContext.orgs[0] ?? null, orgs: orgContext.orgs }),
}));

const ORGS = [
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

const CHECK_DATA: CheckDetailData = {
  id: "c1",
  organizationId: "org-source",
  notificationChannelIds: ["email"],
  name: "Nightly backup",
  slug: "nightly-backup",
  type: "HEARTBEAT",
  target: null,
  method: null,
  expectedStatus: null,
  intervalSeconds: null,
  timeoutMs: null,
  periodSeconds: 300,
  graceSeconds: 60,
  schedule: null,
  tz: null,
  nextExpectedAt: null,
  status: "UP",
  pingSlug: "abc123",
  events: [
    {
      id: "e1",
      status: "UP",
      timestamp: "2026-07-22T11:41:58.645Z",
      error: null,
      responseTimeMs: null,
      statusCode: null,
    },
    {
      id: "e2",
      status: "DOWN",
      timestamp: "2026-07-22T11:00:00.000Z",
      error: "missed heartbeat",
      responseTimeMs: null,
      statusCode: null,
    },
  ],
};

const ENABLED_CHANNELS = [
  {
    __typename: "NotificationChannelModel",
    id: "email",
    organizationId: "org-source",
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
    organizationId: "org-source",
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
    organizationId: "org-source",
    type: "TELEGRAM",
    configJson: '{"chatTitle":"Disabled room"}',
    enabled: false,
    verificationStatus: "NOT_REQUIRED",
    verificationDeliveryStatus: "NOT_REQUIRED",
    verificationExpiresAt: null,
  },
];

const channelsMock = {
  request: {
    query: CHANNELS,
    variables: { organizationId: "org-source" },
  },
  result: { data: { channels: ENABLED_CHANNELS } },
};

function renderDetail(
  props: Partial<Parameters<typeof CheckDetail>[0]> = {},
  mocks: React.ComponentProps<typeof MockedProvider>["mocks"] = [channelsMock],
) {
  return render(
    <MockedProvider mocks={mocks}>
      <CheckDetail
        check={CHECK_DATA}
        loading={false}
        error={undefined}
        onRefetch={() => {}}
        onMoved={() => {}}
        {...props}
      />
    </MockedProvider>
  );
}

describe("CheckDetail", () => {
  beforeEach(() => {
    orgContext.orgs = ORGS;
  });

  it("loads canonical organization identity on the direct route and preserves the legacy tuple", () => {
    expect(print(CHECK)).toContain("organizationId");
    expect(print(CHECK)).not.toContain("projectId");
    expect(print(CHECK)).toContain("notificationChannelIds");
    expect(print(CHECK_BY_SLUG)).toContain("organizationId");
    expect(print(CHECK_BY_SLUG)).toContain("projectId");
    expect(print(CHECK_BY_SLUG)).toContain("notificationChannelIds");
  });

  it("renders the check's name, status badge and events", () => {
    renderDetail();

    expect(screen.getByText("Nightly backup")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "UP" })).toBeInTheDocument();
    expect(screen.getByText("missed heartbeat")).toBeInTheDocument();
  });

  it("shows the skeleton while loading with no data yet", () => {
    const { container } = renderDetail({ check: undefined, loading: true });

    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
    expect(screen.queryByText("Nightly backup")).not.toBeInTheDocument();
  });

  it("surfaces a query error through the error dialog", async () => {
    renderDetail({ error: new Error("Not Found") });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: "Error" })).toBeInTheDocument();
    });
    expect(screen.getByText("Not Found")).toBeInTheDocument();
  });

  it("loads channels once for the check organization and renders enabled detail controls", async () => {
    const channelsResult = vi.fn(() => ({
      data: { channels: ENABLED_CHANNELS },
    }));

    const { container } = renderDetail({}, [
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-source" },
        },
        result: channelsResult,
      },
    ]);

    expect(
      await screen.findByRole("switch", {
        name: /Nightly backup.*Email notifications/i,
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", {
        name: /Nightly backup.*Webhook notifications/i,
      }),
    ).not.toBeChecked();
    expect(
      screen.queryByRole("switch", {
        name: /Telegram notifications/i,
      }),
    ).not.toBeInTheDocument();
    expect(container.querySelector('[data-variant="detail"]')).toBeInTheDocument();
    expect(channelsResult).toHaveBeenCalledTimes(1);
  });

  it("shows a neutral loading state without false notification messaging", async () => {
    renderDetail({}, [
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-source" },
        },
        delay: 150,
        result: { data: { channels: ENABLED_CHANNELS } },
      },
    ]);

    expect(
      screen.getByRole("status", { name: "Loading notification channels" }),
    ).toHaveTextContent("Loading notification channels…");
    expect(
      screen.queryByText("No active notification channels"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Notifications off/)).not.toBeInTheDocument();

    expect(
      await screen.findByRole("switch", {
        name: /Nightly backup.*Email notifications/i,
      }),
    ).toBeChecked();
  });

  it("surfaces channel loading failures and retries for the same organization", async () => {
    const successfulRetry = vi.fn(() => ({
      data: { channels: ENABLED_CHANNELS },
    }));
    renderDetail({}, [
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-source" },
        },
        error: new Error("network unavailable"),
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-source" },
        },
        result: successfulRetry,
      },
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
        name: /Nightly backup.*Email notifications/i,
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

  it("keeps cached controls and shows only the save error when its recovery refetch fails", async () => {
    const failedRefetch = vi.fn(() => ({
      errors: [new GraphQLError("refetch unavailable")],
    }));
    renderDetail({}, [
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-source" },
        },
        result: { data: { channels: ENABLED_CHANNELS } },
      },
      {
        request: {
          query: SET_CHECK_CHANNEL_ENABLED,
          variables: {
            checkId: "c1",
            channelId: "email",
            enabled: false,
          },
        },
        error: new Error("save unavailable"),
      },
      {
        request: {
          query: CHANNELS,
          variables: { organizationId: "org-source" },
        },
        result: failedRefetch,
      },
    ]);

    const emailSwitch = await screen.findByRole("switch", {
      name: /Nightly backup.*Email notifications/i,
    });
    expect(emailSwitch).toBeChecked();

    fireEvent.click(emailSwitch);

    const saveDialog = await screen.findByRole("dialog", { name: "Error" });
    expect(saveDialog).toHaveTextContent(
      "Could not update notifications for Nightly backup. Please try again.",
    );
    await waitFor(() => expect(emailSwitch).toBeChecked());
    await waitFor(() => expect(failedRefetch).toHaveBeenCalledTimes(1));
    expect(
      screen.getByRole("switch", {
        name: /Nightly backup.*Webhook notifications/i,
        hidden: true,
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", {
        name: "Notification channels unavailable",
        hidden: true,
      }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
  });

  it("shows DOWN and recovery history with routing but no acknowledge action", async () => {
    renderDetail({
      check: {
        ...CHECK_DATA,
        status: "DOWN",
        events: [
          {
            id: "recovery",
            status: "UP",
            timestamp: "2026-07-22T12:00:00.000Z",
            error: null,
            responseTimeMs: null,
            statusCode: null,
          },
          {
            id: "outage",
            status: "DOWN",
            timestamp: "2026-07-22T11:00:00.000Z",
            error: "missed heartbeat",
            responseTimeMs: null,
            statusCode: null,
          },
        ],
      },
    });

    expect(screen.getByRole("status", { name: "DOWN" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /acknowledge/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Acknowledged")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByText("Up")).toBeInTheDocument();
    expect(screen.getByText("Down")).toBeInTheDocument();
    expect(
      await screen.findByRole("switch", {
        name: /Nightly backup.*Email notifications/i,
      }),
    ).toBeInTheDocument();
  });
});
