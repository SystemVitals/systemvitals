import { MockedProvider } from "@apollo/client/testing/react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_SET_USER_PLAN, ADMIN_SUBSCRIPTIONS } from "@/lib/admin-queries";
import AdminSubscriptionsPage, { positiveIntegerError } from "./page";

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

describe("AdminSubscriptionsPage", () => {
  const subscription = {
    id: "subscription-1",
    userId: "user-1",
    userEmail: "owner@example.com",
    plan: "SIGNAL",
    status: "active",
    manualOverride: true,
    limitsJson: null,
    stripeSubscriptionId: null,
    createdAt: "2026-07-23T00:00:00.000Z",
  };

  const queryMock = {
    request: {
      query: ADMIN_SUBSCRIPTIONS,
      variables: { page: 0, pageSize: 25 },
    },
    result: {
      data: { adminSubscriptions: { items: [subscription], total: 1 } },
    },
  };

  it("renders account email and user id instead of organization identity", async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: {
              query: ADMIN_SUBSCRIPTIONS,
              variables: { page: 0, pageSize: 25 },
            },
            result: {
              data: {
                adminSubscriptions: {
                  items: [
                    {
                      id: "subscription-1",
                      userId: "user-1",
                      userEmail: "owner@example.com",
                      plan: "SIGNAL",
                      status: "active",
                      manualOverride: true,
                      limitsJson: null,
                      stripeSubscriptionId: null,
                      createdAt: "2026-07-23T00:00:00.000Z",
                    },
                  ],
                  total: 1,
                },
              },
            },
          },
        ]}
      >
        <AdminSubscriptionsPage />
      </MockedProvider>,
    );

    expect(await screen.findByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText("user-1")).toBeInTheDocument();
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage" })).toBeInTheDocument();
  });

  it("submits manual plan changes with the account user id", async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: {
              query: ADMIN_SUBSCRIPTIONS,
              variables: { page: 0, pageSize: 25 },
            },
            result: {
              data: {
                adminSubscriptions: { items: [subscription], total: 1 },
              },
            },
          },
          {
            request: {
              query: ADMIN_SET_USER_PLAN,
              variables: {
                userId: "user-1",
                plan: "SIGNAL",
                limitsJson: null,
                manualOverride: true,
              },
            },
            result: { data: { adminSetUserPlan: subscription } },
          },
        ]}
      >
        <AdminSubscriptionsPage />
      </MockedProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    expect(
      screen.getByRole("heading", { name: "Manage account subscription" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Manage account subscription" }),
      ).not.toBeInTheDocument(),
    );
  });

  it.each(["1.5", "-2", "0"])(
    "rejects malformed custom limit %s without submitting",
    async (value) => {
      render(
        <MockedProvider mocks={[queryMock]}>
          <AdminSubscriptionsPage />
        </MockedProvider>,
      );
      fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
      const maxChecks = screen.getByLabelText("Max checks");
      expect(maxChecks).toHaveAttribute("type", "number");
      expect(maxChecks).toHaveAttribute("min", "1");
      expect(maxChecks).toHaveAttribute("step", "1");
      fireEvent.change(maxChecks, { target: { value } });
      expect(
        screen.getByText("Max checks must be a positive integer."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    },
  );

  it("validates the complete integer string instead of accepting a numeric prefix", () => {
    expect(positiveIntegerError("12x", "Max checks")).toBe(
      "Max checks must be a positive integer.",
    );
    expect(positiveIntegerError("12", "Max checks")).toBeNull();
    expect(positiveIntegerError("", "Max checks")).toBeNull();
  });

  it("keeps a rejected mutation error inside the open edit dialog", async () => {
    render(
      <MockedProvider
        mocks={[
          queryMock,
          {
            request: {
              query: ADMIN_SET_USER_PLAN,
              variables: {
                userId: "user-1",
                plan: "SIGNAL",
                limitsJson: null,
                manualOverride: true,
              },
            },
            error: new Error("Account update rejected"),
          },
        ]}
      >
        <AdminSubscriptionsPage />
      </MockedProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Manage" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText("Account update rejected"),
    ).toBeInTheDocument();
    const dialog = screen.getByRole("dialog", {
      name: "Manage account subscription",
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Account update rejected",
    );
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(
      screen.queryByRole("heading", { name: "Could not update subscription" }),
    ).not.toBeInTheDocument();
  });
});
