import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHECKS, MY_SUBSCRIPTION } from "@/lib/queries";
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
  usePollWhenVisible: () => {},
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

function renderDashboard(viewerPlan: "SOLO" | "SIGNAL") {
  render(
    <MockedProvider mocks={[checksMock, subscriptionMock(viewerPlan)]}>
      <DashboardPage />
    </MockedProvider>
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    context.activeOrg.plan = "SIGNAL";
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
});
