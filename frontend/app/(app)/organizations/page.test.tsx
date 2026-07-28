import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import OrganizationsPage from "./page";
import {
  DELETE_ORGANIZATION,
  LEAVE_ORGANIZATION,
  ORGANIZATION_MEMBERS,
  UPDATE_ORGANIZATION,
} from "@/lib/queries";

const mockSetActiveOrgId = vi.fn();
const mockOrgs = [
  { id: "org1", name: "Acme", slug: "acme", role: "OWNER", plan: "SOLO", creatorUserId: "user1", creatorLabel: "me@example.com", projects: [] },
  { id: "org2", name: "Beta", slug: "beta", role: "MEMBER", plan: "SIGNAL", creatorUserId: "user2", creatorLabel: "creator@example.com", projects: [] },
  { id: "org3", name: "Gamma", slug: "gamma", role: "OWNER", plan: "FLEET", creatorUserId: "user3", creatorLabel: "other@example.com", projects: [] },
];

const mockRefetchMe = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user1", email: "me@example.com" },
    refetchMe: mockRefetchMe,
  }),
}));
vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({
    orgs: mockOrgs,
    activeOrg: mockOrgs[0],
    activeOrgId: "org1",
    setActiveOrgId: mockSetActiveOrgId,
  }),
}));

function renderPage(mocks: MockedResponse[] = []) {
  return render(
    <MockedProvider mocks={mocks}>
      <OrganizationsPage />
    </MockedProvider>,
  );
}

describe("OrganizationsPage", () => {
  beforeEach(() => {
    mockRefetchMe.mockClear();
    mockSetActiveOrgId.mockClear();
  });

  it("lists every org the user belongs to", () => {
    renderPage();
    expect(screen.getByText("Acme")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("offers a Create team action", () => {
    renderPage();
    expect(
      screen.getByRole("button", { name: /create team/i }),
    ).toBeInTheDocument();
  });

  it("explains creator-attributed organization limits without stale free-team wording", () => {
    renderPage();

    expect(
      screen.getByText(
        "SOLO accounts can create or own up to 10 organizations attributed to their account. SIGNAL and FLEET accounts have no limit.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/free teams?/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/paid teams?/i)).not.toBeInTheDocument();
  });

  it("labels own and inherited account plans with a plan badge", () => {
    renderPage();
    expect(screen.getByText("Inherited from your account")).toBeInTheDocument();
    expect(
      screen.getByText("Inherited from creator@example.com"),
    ).toBeInTheDocument();
    expect(screen.getByText("SOLO")).toBeInTheDocument();
    expect(screen.getByText("SIGNAL")).toBeInTheDocument();
  });

  it("offers transfer only on an organization the current user actually created", () => {
    renderPage();
    expect(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /transfer creatorship for beta/i }),
    ).not.toBeInTheDocument();
  });

  it("does not fetch members on page load and fetches the exact creator org once on open", async () => {
    const memberQuery = vi.fn(() => ({
      data: {
        organizationMembers: [
          {
            id: "membership2",
            userId: "user3",
            email: "owner@example.com",
            role: "OWNER",
            createdAt: "2026-01-01",
          },
        ],
      },
    }));
    renderPage([{
      request: {
        query: ORGANIZATION_MEMBERS,
        variables: { organizationId: "org1" },
      },
      result: memberQuery,
    }]);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(memberQuery).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: /transfer creatorship for acme/i }),
    );
    await waitFor(() => expect(memberQuery).toHaveBeenCalledTimes(1));
  });

  it("shows delete only for orgs the user owns, and leave only for others", () => {
    renderPage();
    expect(
      screen.getByRole("button", { name: /delete acme/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete beta/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /leave beta/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /leave acme/i }),
    ).not.toBeInTheDocument();
  });

  it("requires confirmation before leaving an organization", async () => {
    const leaveResult = vi.fn(() => ({
      data: { leaveOrganization: true },
    }));
    const leaveMock = {
      request: {
        query: LEAVE_ORGANIZATION,
        variables: { organizationId: "org2" },
      },
      result: leaveResult,
    };
    renderPage([leaveMock]);

    fireEvent.click(screen.getByRole("button", { name: /leave beta/i }));

    expect(
      await screen.findByRole("heading", { name: /leave beta/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/lose access to beta/i),
    ).toBeInTheDocument();
    expect(leaveResult).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: /^confirm leave$/i }),
    );

    await waitFor(() => expect(leaveResult).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockRefetchMe).toHaveBeenCalled());
  });

  it("shows no Edit and no Delete control for a MEMBER's org", () => {
    renderPage();
    // Positive side: Acme (OWNER) has both.
    expect(
      screen.getByRole("button", { name: /edit acme/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /delete acme/i }),
    ).toBeInTheDocument();
    // Negative side: Beta (MEMBER) has neither.
    expect(
      screen.queryByRole("button", { name: /edit beta/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /delete beta/i }),
    ).not.toBeInTheDocument();
  });

  it("gates the delete button on typing the exact org name", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /delete acme/i }));

    const confirmInput = await screen.findByLabelText(
      /confirm organization name/i,
    );
    const deleteButton = screen.getByRole("button", {
      name: /^delete organization$/i,
    });

    expect(deleteButton).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: "Wrong Name" } });
    expect(deleteButton).toBeDisabled();

    fireEvent.change(confirmInput, { target: { value: "Acme" } });
    expect(deleteButton).toBeEnabled();
  });

  it("says deletion leaves account billing unaffected and rejects stale cancellation copy", async () => {
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: /delete gamma/i }));

    expect(
      await screen.findByText(
        /this permanently deletes all of gamma's projects, checks, and history/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/account billing is unaffected/i)).toBeInTheDocument();
    expect(screen.getByText(/manage billing separately/i)).toBeInTheDocument();
    expect(screen.queryByText(/cancel(?:s|led|lation)?/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/free teams?/i)).not.toBeInTheDocument();
  });

  it("fires DELETE_ORGANIZATION with the org id when the delete is confirmed", async () => {
    const deleteMock = {
      request: {
        query: DELETE_ORGANIZATION,
        variables: { organizationId: "org1" },
      },
      result: { data: { deleteOrganization: true } },
    };

    renderPage([deleteMock]);

    fireEvent.click(screen.getByRole("button", { name: /delete acme/i }));

    const confirmInput = await screen.findByLabelText(
      /confirm organization name/i,
    );
    fireEvent.change(confirmInput, { target: { value: "Acme" } });

    fireEvent.click(
      screen.getByRole("button", { name: /^delete organization$/i }),
    );

    await waitFor(() => expect(mockRefetchMe).toHaveBeenCalled());
  });

  it("fires UPDATE_ORGANIZATION with the new name when a rename is saved", async () => {
    const renameMock = {
      request: {
        query: UPDATE_ORGANIZATION,
        variables: { organizationId: "org1", name: "Acme Renamed" },
      },
      result: {
        data: {
          updateOrganization: {
            id: "org1",
            name: "Acme Renamed",
            slug: "acme",
          },
        },
      },
    };

    renderPage([renameMock]);

    fireEvent.click(screen.getByRole("button", { name: /edit acme/i }));

    const nameInput = await screen.findByLabelText(/^name$/i);
    fireEvent.change(nameInput, { target: { value: "Acme Renamed" } });

    fireEvent.click(screen.getByRole("button", { name: /^save name$/i }));

    await waitFor(() => expect(mockRefetchMe).toHaveBeenCalled());
  });
});
