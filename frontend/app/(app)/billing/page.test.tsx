import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApolloLink, Observable } from "@apollo/client";
import { MockedProvider } from "@apollo/client/testing/react";
import { print } from "graphql";
import { MY_SUBSCRIPTION } from "@/lib/queries";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: {
      id: "u1",
      email: "ada@example.com",
      isAdmin: false,
      hasPassword: true,
      googleLinked: false,
      organizations: [],
    },
  }),
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => {
    throw new Error("Billing must not depend on the active organization");
  },
}));

import BillingPage from "./page";

const subscriptionMock = (
  plan: string,
  {
    checkCount = 3,
    maxChecks = 100,
    organizationCount = 1,
  }: {
    checkCount?: number;
    maxChecks?: number;
    organizationCount?: number;
  } = {}
) => ({
  request: {
    query: MY_SUBSCRIPTION,
  },
  result: {
    data: {
      mySubscription: {
        plan,
        status: "active",
        checkCount,
        maxChecks,
        organizationCount,
      },
    },
  },
});

describe("BillingPage", () => {
  beforeEach(() => {
    localStorage.setItem("sv_token", "test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ url: "#billing-session" }),
      })
    );
  });

  it("declares an account-scoped subscription query with no variables", () => {
    expect(print(MY_SUBSCRIPTION)).toBe(`query mySubscription {
  mySubscription {
    plan
    status
    checkCount
    maxChecks
    organizationCount
  }
}`);
  });

  it("loads billing without reading the active organization", async () => {
    render(
      <MockedProvider mocks={[subscriptionMock("FLEET")]}>
        <BillingPage />
      </MockedProvider>
    );

    expect(
      await screen.findByRole("button", { name: /upgrade to signal/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /upgrade to fleet/i }),
    ).toBeNull();
  });

  it("does not expose billing actions while the subscription is loading", async () => {
    let resolveSubscription!: (value: ReturnType<typeof subscriptionMock>["result"]) => void;
    const subscriptionResult = new Promise<
      ReturnType<typeof subscriptionMock>["result"]
    >((resolve) => {
      resolveSubscription = resolve;
    });
    const link = new ApolloLink(
      () =>
        new Observable((observer) => {
          void subscriptionResult.then((result) => {
            observer.next(result);
            observer.complete();
          });
        }),
    );

    render(
      <MockedProvider link={link}>
        <BillingPage />
      </MockedProvider>
    );

    expect(screen.queryByRole("button", { name: /upgrade to/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open billing portal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /current plan/i })).toBeNull();
    expect(screen.getByRole("button", { name: /monthly/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /yearly/i })).toBeDisabled();

    await act(async () => {
      resolveSubscription(subscriptionMock("SOLO").result);
      await subscriptionResult;
    });
    expect(
      await screen.findByRole("button", { name: /upgrade to signal/i }),
    ).toBeEnabled();
  });

  it("sends only plan and interval in the checkout POST body", async () => {
    render(
      <MockedProvider mocks={[subscriptionMock("SOLO")]}>
        <BillingPage />
      </MockedProvider>
    );

    const yearly = screen.getByRole("button", { name: /yearly/i });
    await waitFor(() => expect(yearly).toBeEnabled());
    fireEvent.click(yearly);
    fireEvent.click(
      screen.getByRole("button", { name: /upgrade to signal/i })
    );

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({
      plan: "SIGNAL",
      interval: "year",
    });
  });

  it("sends an empty object in the portal POST body", async () => {
    render(
      <MockedProvider mocks={[subscriptionMock("SIGNAL")]}>
        <BillingPage />
      </MockedProvider>
    );

    fireEvent.click(await screen.findByRole("button", { name: /open billing portal/i }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled();
    });

    const [, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(JSON.parse(init.body as string)).toEqual({});
  });

  it("renders account-wide usage with the API custom check limit", async () => {
    render(
      <MockedProvider
        mocks={[
          subscriptionMock("SIGNAL", {
            checkCount: 42,
            maxChecks: 137,
            organizationCount: 4,
          }),
        ]}
      >
        <BillingPage />
      </MockedProvider>
    );

    expect(
      await screen.findByText("42 / 137 checks across 4 organizations")
    ).toBeInTheDocument();
    expect(screen.getByText("95 checks left")).toBeInTheDocument();
  });

  it.each(["SIGNAL", "FLEET"])(
    "shows a 60-second minimum interval for the %s plan with no paid 1-second claim",
    async (plan) => {
      render(
        <MockedProvider mocks={[subscriptionMock(plan)]}>
          <BillingPage />
        </MockedProvider>
      );

      expect(
        await screen.findByText(
          (_, element) =>
            element?.tagName === "P" &&
            element.textContent?.includes("60s between checks") === true
        )
      ).toBeInTheDocument();
      expect(screen.getAllByText("60 sec min interval")).toHaveLength(2);
      expect(
        screen.queryByText(
          (_, element) =>
            element?.tagName === "P" &&
            element.textContent?.includes("1s between checks") === true
        )
      ).toBeNull();
      expect(screen.queryByText("1 sec min interval")).toBeNull();
    }
  );

  it("shows subscription query errors in the existing dialog", async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: { query: MY_SUBSCRIPTION },
            error: new Error("Unable to load account billing"),
          },
        ]}
      >
        <BillingPage />
      </MockedProvider>
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveAccessibleDescription("Unable to load account billing");
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: /upgrade to/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /open billing portal/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /current plan/i })).toBeNull();
    expect(screen.getByText("Monthly").closest("button")).toBeDisabled();
    expect(screen.getByText("Yearly").closest("button")).toBeDisabled();
  });

  it("allows only the first of concurrent billing actions", async () => {
    let resolveFetch!: (value: {
      ok: boolean;
      json: () => Promise<{ url: string }>;
    }) => void;
    const fetchPromise = new Promise<{
      ok: boolean;
      json: () => Promise<{ url: string }>;
    }>((resolve) => {
      resolveFetch = resolve;
    });
    vi.mocked(global.fetch).mockReturnValue(fetchPromise as Promise<Response>);

    render(
      <MockedProvider mocks={[subscriptionMock("SOLO")]}>
        <BillingPage />
      </MockedProvider>
    );

    const signal = await screen.findByRole("button", {
      name: /upgrade to signal/i,
    });
    const fleet = screen.getByRole("button", { name: /upgrade to fleet/i });

    act(() => {
      signal.click();
      fleet.click();
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = vi.mocked(global.fetch).mock.calls[0];
    expect(JSON.parse(init?.body as string)).toEqual({
      plan: "SIGNAL",
      interval: "month",
    });
    expect(screen.getByRole("button", { name: /yearly/i })).toBeDisabled();
    expect(fleet).toBeDisabled();

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ url: "#billing-session" }),
      });
      await fetchPromise;
    });
  });

  it("disables checkout, portal, and interval actions during any request", async () => {
    const fetchPromise = new Promise<Response>(() => {});
    vi.mocked(global.fetch).mockReturnValue(fetchPromise);

    render(
      <MockedProvider mocks={[subscriptionMock("SIGNAL")]}>
        <BillingPage />
      </MockedProvider>
    );

    const checkout = await screen.findByRole("button", {
      name: /upgrade to fleet/i,
    });
    const portal = screen.getByRole("button", {
      name: /open billing portal/i,
    });
    fireEvent.click(checkout);

    expect(checkout).toBeDisabled();
    expect(portal).toBeDisabled();
    expect(screen.getByRole("button", { name: /monthly/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /yearly/i })).toBeDisabled();
  });

  it("exposes the billing interval as a pressed button group", async () => {
    render(
      <MockedProvider mocks={[subscriptionMock("SOLO")]}>
        <BillingPage />
      </MockedProvider>
    );

    const group = await screen.findByRole("group", {
      name: /billing interval/i,
    });
    const monthly = screen.getByRole("button", { name: /monthly/i });
    const yearly = screen.getByRole("button", { name: /yearly/i });
    await waitFor(() => expect(yearly).toBeEnabled());

    expect(group).toContainElement(monthly);
    expect(group).toContainElement(yearly);
    expect(monthly).toHaveAttribute("aria-pressed", "true");
    expect(yearly).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(yearly);

    expect(monthly).toHaveAttribute("aria-pressed", "false");
    expect(yearly).toHaveAttribute("aria-pressed", "true");
  });
});
