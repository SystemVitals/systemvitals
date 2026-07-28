import {
  ApolloClient,
  ApolloLink,
  gql,
  InMemoryCache,
  Observable,
} from "@apollo/client";
import { ApolloProvider, useQuery } from "@apollo/client/react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { print } from "graphql";
import { describe, expect, it, vi } from "vitest";
import {
  CheckNotificationChannels,
  type NotificationChannelOption,
} from "@/components/app/check-notification-channels";
import { CHANNELS, SET_CHECK_CHANNEL_ENABLED } from "@/lib/queries";

const CHANNEL_OPTIONS = [
  {
    id: "email",
    type: "EMAIL",
    configJson: '{"email":"alerts@example.com"}',
    enabled: true,
  },
  {
    id: "telegram",
    type: "TELEGRAM",
    configJson:
      '{"chatTitle":"Incident room","chatId":"-100123","messageThreadId":42}',
    enabled: true,
  },
  {
    id: "webhook",
    type: "WEBHOOK",
    configJson:
      '{"url":"https://deploy-user:super-secret@hooks.example.com/services/private-token"}',
    enabled: true,
  },
  {
    id: "slack",
    type: "SLACK",
    configJson:
      '{"webhookUrl":"https://hooks.slack.com/services/T000/B000/credential"}',
    enabled: true,
  },
  {
    id: "custom",
    type: "PAGERDUTY",
    configJson: '{"routingKey":"do-not-render-this-secret"}',
    enabled: true,
  },
] satisfies NotificationChannelOption[];

interface PendingMutation {
  variables: Record<string, unknown>;
  succeed: () => void;
  fail: () => void;
}

function createClient() {
  const pending: PendingMutation[] = [];
  const link = new ApolloLink(
    (operation) =>
      new Observable((observer) => {
        const variables = { ...operation.variables };
        pending.push({
          variables,
          succeed: () => {
            observer.next({
              data: {
                setCheckChannelEnabled: {
                  __typename: "CheckModel",
                  id: variables.checkId,
                  notificationChannelIds: variables.enabled
                    ? [variables.channelId]
                    : [],
                },
              },
            });
            observer.complete();
          },
          fail: () => observer.error(new Error("save failed")),
        });
      }),
  );
  const client = new ApolloClient({ cache: new InMemoryCache(), link });

  return { client, pending };
}

function renderControl({
  channels = CHANNEL_OPTIONS,
  notificationChannelIds = [],
  variant = "compact",
  client = createClient().client,
}: {
  channels?: NotificationChannelOption[];
  notificationChannelIds?: string[];
  variant?: "compact" | "detail";
  client?: ApolloClient;
} = {}) {
  return render(
    <ApolloProvider client={client}>
      <CheckNotificationChannels
        checkId="check-1"
        checkName="Nightly backup"
        notificationChannelIds={notificationChannelIds}
        channels={channels}
        variant={variant}
      />
    </ApolloProvider>,
  );
}

function getSwitch(channelLabel: string) {
  return screen.getByRole("switch", {
    name: new RegExp(`Nightly backup.*${channelLabel}`, "i"),
  });
}

describe("CheckNotificationChannels", () => {
  it("declares the target-only channel mutation", () => {
    const operation = print(SET_CHECK_CHANNEL_ENABLED);

    expect(operation).toMatch(
      /setCheckChannelEnabled\(\s*checkId: \$checkId\s*channelId: \$channelId\s*enabled: \$enabled\s*\)/,
    );
    expect(operation).toContain("notificationChannelIds");
  });

  it("maps every channel type to its approved icon and fallback", () => {
    const { container } = renderControl();

    expect(container.querySelector(".lucide-mail")).toBeInTheDocument();
    expect(container.querySelector(".lucide-send")).toBeInTheDocument();
    expect(container.querySelector(".lucide-webhook")).toBeInTheDocument();
    expect(container.querySelector(".lucide-message-square")).toBeInTheDocument();
    expect(container.querySelector(".lucide-bell")).toBeInTheDocument();
    expect(screen.getByText("Pagerduty")).toBeInTheDocument();
  });

  it("shows safe destination summaries without leaking credentials or raw config", () => {
    renderControl({
      channels: [
        ...CHANNEL_OPTIONS,
        {
          id: "broken-email",
          type: "EMAIL",
          configJson: '{"email":"not an email","apiKey":"email-secret"}',
          enabled: true,
        },
        {
          id: "broken-webhook",
          type: "WEBHOOK",
          configJson: '{"url":"not a URL","token":"webhook-secret"}',
          enabled: true,
        },
        {
          id: "broken-slack",
          type: "SLACK",
          configJson: "{slack-secret",
          enabled: true,
        },
      ],
    });

    expect(screen.getByText("alerts@example.com")).toBeInTheDocument();
    expect(screen.getByText("Incident room · topic 42")).toBeInTheDocument();
    expect(screen.getByText("hooks.example.com")).toBeInTheDocument();
    expect(screen.getByText("hooks.slack.com")).toBeInTheDocument();
    expect(screen.getByText("Notification destination")).toBeInTheDocument();
    expect(screen.getByText("Email destination")).toBeInTheDocument();
    expect(screen.getByText("Webhook destination")).toBeInTheDocument();
    expect(screen.getByText("Slack destination")).toBeInTheDocument();
    expect(screen.queryByText(/super-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/private-token/)).not.toBeInTheDocument();
    expect(screen.queryByText(/do-not-render/)).not.toBeInTheDocument();
    expect(screen.queryByText(/email-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/webhook-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/slack-secret/)).not.toBeInTheDocument();
  });

  it("uses a chat ID when Telegram has no title and hides malformed Telegram config", () => {
    renderControl({
      channels: [
        {
          id: "chat-id",
          type: "TELEGRAM",
          configJson: '{"chatId":-100987,"messageThreadId":"release"}',
          enabled: true,
        },
        {
          id: "broken",
          type: "TELEGRAM",
          configJson: '{"botToken":"telegram-secret"',
          enabled: true,
        },
      ],
    });

    expect(screen.getByText("-100987 · topic release")).toBeInTheDocument();
    expect(screen.getByText("Telegram destination")).toBeInTheDocument();
    expect(screen.queryByText(/telegram-secret/)).not.toBeInTheDocument();
  });

  it("renders only enabled channels and reflects selected state", () => {
    renderControl({
      channels: [
        CHANNEL_OPTIONS[0],
        { ...CHANNEL_OPTIONS[1], enabled: false },
      ],
      notificationChannelIds: ["email", "telegram"],
    });

    expect(getSwitch("Email")).toBeChecked();
    expect(
      screen.queryByRole("switch", { name: /Telegram/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the exact all-off warning", () => {
    renderControl({ notificationChannelIds: [] });

    expect(
      screen.getByText(
        "Notifications off — This check will not send DOWN or RECOVERY notifications.",
      ),
    ).toBeInTheDocument();
  });

  it("shows the no-active state and channels CTA", () => {
    renderControl({ channels: [] });

    expect(screen.getByText("No active notification channels")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Add or activate a notification channel" }),
    ).toHaveAttribute("href", "/channels");
  });

  it("uses compact and detail presentation densities", () => {
    const compact = renderControl({ variant: "compact" });
    expect(compact.container.firstElementChild).toHaveAttribute(
      "data-variant",
      "compact",
    );
    expect(compact.container.querySelector('[data-slot="channel-row"]')).toHaveClass(
      "py-2",
    );
    compact.unmount();

    const detail = renderControl({ variant: "detail" });
    expect(detail.container.firstElementChild).toHaveAttribute(
      "data-variant",
      "detail",
    );
    expect(detail.container.querySelector('[data-slot="channel-row"]')).toHaveClass(
      "py-3",
    );
  });

  it("labels switches with the check and channel and supports keyboard toggling", async () => {
    const { client, pending } = createClient();
    renderControl({ channels: [CHANNEL_OPTIONS[0]], client });
    const email = getSwitch("Email");

    email.focus();
    fireEvent.keyDown(email, { key: " ", code: "Space" });
    fireEvent.keyUp(email, { key: " ", code: "Space" });

    await waitFor(() => expect(pending).toHaveLength(1));
    expect(email).toBeChecked();
    expect(pending[0].variables).toEqual({
      checkId: "check-1",
      channelId: "email",
      enabled: true,
    });
  });

  it("saves immediately, disables only the pending switch, and blocks duplicates", async () => {
    const { client, pending } = createClient();
    renderControl({
      channels: [CHANNEL_OPTIONS[0], CHANNEL_OPTIONS[2]],
      client,
    });
    const email = getSwitch("Email");
    const webhook = getSwitch("Webhook");

    fireEvent.click(email);

    expect(email).toBeChecked();
    expect(email).toHaveAttribute("aria-disabled", "true");
    expect(webhook).toBeEnabled();
    expect(screen.getByText("Saving…")).toBeInTheDocument();
    expect(
      screen.getByText("Saving…").parentElement?.querySelector(
        ".lucide-loader-circle",
      ),
    ).toBeInTheDocument();
    fireEvent.click(email);
    expect(pending).toHaveLength(1);

    pending[0].succeed();
    await waitFor(() => expect(email).toBeEnabled());
    expect(screen.queryByText("Saving…")).not.toBeInTheDocument();
  });

  it("modifies only the target field on the normalized CheckModel after success", async () => {
    const { client, pending } = createClient();
    const checkId = client.cache.identify({
      __typename: "CheckModel",
      id: "check-1",
    });
    client.cache.writeFragment({
      id: checkId,
      fragment: gql`
        fragment SeedCheckNotifications on CheckModel {
          id
          notificationChannelIds
        }
      `,
      data: {
        __typename: "CheckModel",
        id: "check-1",
        notificationChannelIds: ["email", "unrelated"],
      },
    });
    const modify = vi.spyOn(client.cache, "modify");
    renderControl({
      channels: [CHANNEL_OPTIONS[0], CHANNEL_OPTIONS[2]],
      notificationChannelIds: ["email"],
      client,
    });

    fireEvent.click(getSwitch("Webhook"));
    pending[0].succeed();

    await waitFor(() =>
      expect(
        client.cache.readFragment<{
          notificationChannelIds: string[];
        }>({
          id: checkId,
          fragment: gql`
            fragment ReadCheckNotifications on CheckModel {
              notificationChannelIds
            }
          `,
        })?.notificationChannelIds,
      ).toEqual(["email", "unrelated", "webhook"]),
    );
    expect(modify).toHaveBeenCalledWith(
      expect.objectContaining({
        id: checkId,
        fields: { notificationChannelIds: expect.any(Function) },
      }),
    );
  });

  it("rolls back only the failed target, refetches channels, and opens an error dialog", async () => {
    const { client, pending } = createClient();
    const refetchQueries = vi
      .spyOn(client, "refetchQueries")
      .mockResolvedValue([]);
    renderControl({
      channels: [CHANNEL_OPTIONS[0], CHANNEL_OPTIONS[2]],
      notificationChannelIds: ["webhook"],
      client,
    });
    const email = getSwitch("Email");
    const webhook = getSwitch("Webhook");

    fireEvent.click(email);
    expect(email).toBeChecked();
    pending[0].fail();

    await waitFor(() => expect(email).not.toBeChecked());
    expect(webhook).toBeChecked();
    expect(refetchQueries).toHaveBeenCalledWith({ include: [CHANNELS] });
    expect(await screen.findByRole("dialog", { name: "Error" })).toHaveTextContent(
      "Could not update notifications for Nightly backup. Please try again.",
    );
  });

  it("keeps different-channel writes independent when they resolve out of order", async () => {
    const { client, pending } = createClient();
    const checkId = client.cache.identify({
      __typename: "CheckModel",
      id: "check-1",
    });
    client.cache.writeFragment({
      id: checkId,
      fragment: gql`
        fragment SeedConcurrentCheckNotifications on CheckModel {
          id
          notificationChannelIds
        }
      `,
      data: {
        __typename: "CheckModel",
        id: "check-1",
        notificationChannelIds: [],
      },
    });
    renderControl({
      channels: [CHANNEL_OPTIONS[0], CHANNEL_OPTIONS[2]],
      client,
    });

    fireEvent.click(getSwitch("Email"));
    fireEvent.click(getSwitch("Webhook"));
    expect(pending).toHaveLength(2);
    expect(getSwitch("Email")).toBeChecked();
    expect(getSwitch("Webhook")).toBeChecked();

    pending[1].succeed();
    await waitFor(() => expect(getSwitch("Webhook")).toBeEnabled());
    expect(getSwitch("Email")).toHaveAttribute("aria-disabled", "true");
    expect(getSwitch("Email")).toBeChecked();

    pending[0].succeed();
    await waitFor(() => expect(getSwitch("Email")).toBeEnabled());
    expect(getSwitch("Email")).toBeChecked();
    expect(getSwitch("Webhook")).toBeChecked();
    expect(
      client.cache.readFragment<{ notificationChannelIds: string[] }>({
        id: checkId,
        fragment: gql`
          fragment ReadConcurrentCheckNotifications on CheckModel {
            notificationChannelIds
          }
        `,
      })?.notificationChannelIds,
    ).toEqual(["webhook", "email"]);
  });

  it("reconciles new props without wiping a still-pending local selection", async () => {
    const { client, pending } = createClient();
    const view = render(
      <ApolloProvider client={client}>
        <CheckNotificationChannels
          checkId="check-1"
          checkName="Nightly backup"
          notificationChannelIds={[]}
          channels={[CHANNEL_OPTIONS[0], CHANNEL_OPTIONS[2]]}
          variant="compact"
        />
      </ApolloProvider>,
    );

    fireEvent.click(getSwitch("Email"));
    view.rerender(
      <ApolloProvider client={client}>
        <CheckNotificationChannels
          checkId="check-1"
          checkName="Nightly backup"
          notificationChannelIds={["webhook"]}
          channels={[CHANNEL_OPTIONS[0], CHANNEL_OPTIONS[2]]}
          variant="compact"
        />
      </ApolloProvider>,
    );

    expect(getSwitch("Email")).toBeChecked();
    expect(getSwitch("Webhook")).toBeChecked();
    pending[0].succeed();
    await waitFor(() => expect(getSwitch("Email")).toBeEnabled());
  });
});

const SHARED_CHECK = gql`
  query SharedNotificationCheck {
    sharedNotificationCheck {
      id
      name
      notificationChannelIds
    }
  }
`;

interface SharedCheckData {
  sharedNotificationCheck: {
    id: string;
    name: string;
    notificationChannelIds: string[];
  };
}

function SharedControls() {
  const { data } = useQuery<SharedCheckData>(SHARED_CHECK, {
    fetchPolicy: "cache-only",
  });
  const check = data?.sharedNotificationCheck;
  if (!check) return null;

  const props = {
    checkId: check.id,
    checkName: check.name,
    notificationChannelIds: check.notificationChannelIds,
    channels: [CHANNEL_OPTIONS[0]],
  };

  return (
    <>
      <div data-testid="compact-control">
        <CheckNotificationChannels {...props} variant="compact" />
      </div>
      <div data-testid="detail-control">
        <CheckNotificationChannels {...props} variant="detail" />
      </div>
    </>
  );
}

it("updates compact and detail controls backed by the same normalized CheckModel", async () => {
  const { client, pending } = createClient();
  client.cache.writeQuery({
    query: SHARED_CHECK,
    data: {
      sharedNotificationCheck: {
        __typename: "CheckModel",
        id: "check-1",
        name: "Nightly backup",
        notificationChannelIds: [],
      },
    },
  });
  render(
    <ApolloProvider client={client}>
      <SharedControls />
    </ApolloProvider>,
  );
  const compact = within(screen.getByTestId("compact-control"));
  const detail = within(screen.getByTestId("detail-control"));

  fireEvent.click(
    compact.getByRole("switch", { name: /Nightly backup.*Email/i }),
  );
  expect(
    detail.getByRole("switch", { name: /Nightly backup.*Email/i }),
  ).not.toBeChecked();
  pending[0].succeed();

  await waitFor(() =>
    expect(
      detail.getByRole("switch", { name: /Nightly backup.*Email/i }),
    ).toBeChecked(),
  );
  expect(
    compact.getByRole("switch", { name: /Nightly backup.*Email/i }),
  ).toBeChecked();
});
