import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { GraphQLError } from "graphql";
import TeamPage from "./page";
import {
  ORGANIZATION_MEMBERS,
  ORGANIZATION_INVITES,
  UPDATE_MEMBER_ROLE,
} from "@/lib/queries";

let mockRole = "OWNER";

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    orgs: [],
    activeOrg: { id: "org1", name: "Acme", role: mockRole, projects: [] },
    activeOrgId: "org1",
    setActiveOrgId: vi.fn(),
  }),
}));

const mockRefetchMe = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ refetchMe: mockRefetchMe }),
}));

const membersMock = {
  request: {
    query: ORGANIZATION_MEMBERS,
    variables: { organizationId: "org1" },
  },
  result: {
    data: {
      organizationMembers: [
        {
          id: "m1",
          userId: "u1",
          email: "owner@example.com",
          role: "OWNER",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "m2",
          userId: "u2",
          email: "member@example.com",
          role: "MEMBER",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      ],
    },
  },
};

const invitesMock = {
  request: {
    query: ORGANIZATION_INVITES,
    variables: { organizationId: "org1" },
  },
  result: {
    data: {
      organizationInvites: [
        {
          id: "inv1",
          email: "pending@example.com",
          role: "MEMBER",
          token: "tok1",
          acceptUrl: "http://localhost:9999/invite/tok1",
          expiresAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    },
  },
};

const mocks = [membersMock, invitesMock];

function renderPage(customMocks: MockedResponse[] = mocks) {
  return render(
    <MockedProvider mocks={customMocks}>
      <TeamPage />
    </MockedProvider>,
  );
}

describe("TeamPage", () => {
  beforeEach(() => {
    mockRole = "OWNER";
    mockRefetchMe.mockClear();
  });

  it("lists the organization's members", async () => {
    renderPage();
    expect(await screen.findByText("owner@example.com")).toBeInTheDocument();
    expect(screen.getByText("member@example.com")).toBeInTheDocument();
  });

  it("lists pending invites with a copy-link control", async () => {
    renderPage();
    expect(await screen.findByText("pending@example.com")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy link/i }),
    ).toBeInTheDocument();
  });

  it("shows the invite form to an owner", async () => {
    renderPage();
    expect(
      await screen.findByRole("button", { name: /send invite/i }),
    ).toBeInTheDocument();
  });

  it("hides the invite form from a plain member", async () => {
    mockRole = "MEMBER";
    renderPage();
    await screen.findByText("owner@example.com");
    expect(
      screen.queryByRole("button", { name: /send invite/i }),
    ).not.toBeInTheDocument();
  });

  it("refreshes the viewer's own role after a role change (self-demotion)", async () => {
    const updateMemberRoleMock = {
      request: {
        query: UPDATE_MEMBER_ROLE,
        variables: { membershipId: "m1", role: "MEMBER" },
      },
      result: {
        data: { updateMemberRole: { id: "m1", role: "MEMBER" } },
      },
    };

    // Refetched members list, reflecting the now-demoted owner -- lets the
    // test also wait for refetchAll's members.refetch() to have actually
    // settled (not just for refetchMe to have been called), so nothing is
    // left in flight when the test tears down.
    const membersMockAfter = {
      ...membersMock,
      result: {
        data: {
          organizationMembers: [
            { ...membersMock.result.data.organizationMembers[0], role: "MEMBER" },
            membersMock.result.data.organizationMembers[1],
          ],
        },
      },
    };

    renderPage([
      membersMock,
      invitesMock,
      updateMemberRoleMock,
      membersMockAfter,
      invitesMock,
    ]);

    await screen.findByText("owner@example.com");

    const trigger = screen.getByRole("combobox", {
      name: "Role for owner@example.com",
    });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    });
    const memberOption = screen
      .getAllByRole("option")
      .find((o) => o.textContent === "Member")!;
    fireEvent.pointerDown(memberOption, { pointerType: "mouse" });
    fireEvent.click(memberOption);

    await waitFor(() => {
      expect(mockRefetchMe).toHaveBeenCalledTimes(1);
    });

    // Wait for the members refetch to actually settle too (the row now
    // reads "Member"), so refetchAll's Promise.all has fully resolved and
    // nothing is left in flight for the next test's unmount to abort.
    await waitFor(() => {
      expect(
        screen.getByRole("combobox", { name: "Role for owner@example.com" }),
      ).toHaveTextContent("Member");
    });
  });
});

describe("TeamPage query errors", () => {
  beforeEach(() => {
    mockRole = "OWNER";
    mockRefetchMe.mockClear();
  });

  it("surfaces a failing members query in the error dialog, and it can be dismissed", async () => {
    const failingMembersMock = {
      request: {
        query: ORGANIZATION_MEMBERS,
        variables: { organizationId: "org1" },
      },
      result: {
        errors: [new GraphQLError("Could not load members.")],
      },
    };

    renderPage([failingMembersMock, invitesMock]);

    expect(
      await screen.findByText("Something went wrong"),
    ).toBeInTheDocument();
    expect(screen.getByText("Could not load members.")).toBeInTheDocument();

    // Let the (successful) invites query settle too, so nothing is still
    // in-flight when the test unmounts the tree below.
    await screen.findByText("pending@example.com");

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    // The error is surfaced through a Promise.resolve().then()-deferred
    // setState. A regression that re-opened the dialog on the dismiss
    // re-render (e.g. an error effect that also depended on errorMessage)
    // would queue its reopen as a deferred microtask. A synchronous expect,
    // and even waitFor(absence), pass on the *transient* absence right after
    // the click, before that reopen fires. So flush pending work first, and
    // only THEN assert the dialog stayed gone — that genuinely pins
    // "dismissal is durable".
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});
