import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { CreateTeamDialog } from "./create-team-dialog";
import { CREATE_ORGANIZATION } from "@/lib/queries";

const mockRefetchMe = vi.fn().mockResolvedValue(undefined);
const mockSetActiveOrgId = vi.fn();

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ refetchMe: mockRefetchMe }),
}));
vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ setActiveOrgId: mockSetActiveOrgId }),
}));

function renderDialog(mocks: MockedResponse[] = []) {
  return render(
    <MockedProvider mocks={mocks}>
      <CreateTeamDialog />
    </MockedProvider>,
  );
}

describe("CreateTeamDialog", () => {
  beforeEach(() => {
    mockRefetchMe.mockReset();
    mockRefetchMe.mockResolvedValue(undefined);
    mockSetActiveOrgId.mockClear();
  });

  it("creates a team, refetches, and switches to the new org", async () => {
    const createMock = {
      request: { query: CREATE_ORGANIZATION, variables: { name: "New Team" } },
      result: {
        data: {
          createOrganization: {
            id: "org3",
            name: "New Team",
            slug: "new-team",
            role: "OWNER",
            plan: "SOLO",
          },
        },
      },
    };
    renderDialog([createMock]);

    fireEvent.click(screen.getByRole("button", { name: /create team/i }));
    fireEvent.change(await screen.findByLabelText(/team name/i), {
      target: { value: "New Team" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => expect(mockRefetchMe).toHaveBeenCalled());
    expect(mockSetActiveOrgId).toHaveBeenCalledWith("org3");
  });

  it("surfaces a create error in a dialog", async () => {
    const failMock = {
      request: { query: CREATE_ORGANIZATION, variables: { name: "X" } },
      error: new Error("You can own at most 10 free organizations."),
    };
    renderDialog([failMock]);

    fireEvent.click(screen.getByRole("button", { name: /create team/i }));
    fireEvent.change(await screen.findByLabelText(/team name/i), {
      target: { value: "X" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(
      await screen.findByText(/at most 10 free organizations/i),
    ).toBeInTheDocument();
    expect(mockSetActiveOrgId).not.toHaveBeenCalled();
  });

  it("keeps the created org selected and surfaces a refetch failure after closing the form", async () => {
    mockRefetchMe.mockRejectedValueOnce(new Error("Could not refresh teams."));
    const createMock = {
      request: { query: CREATE_ORGANIZATION, variables: { name: "New Team" } },
      result: {
        data: {
          createOrganization: {
            id: "org3",
            name: "New Team",
            slug: "new-team",
            role: "OWNER",
            plan: "SOLO",
          },
        },
      },
    };
    renderDialog([createMock]);

    fireEvent.click(screen.getByRole("button", { name: /create team/i }));
    fireEvent.change(await screen.findByLabelText(/team name/i), {
      target: { value: "New Team" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(
      await screen.findByText(/could not refresh teams/i),
    ).toBeInTheDocument();
    expect(mockSetActiveOrgId).toHaveBeenCalledWith("org3");
    expect(screen.queryByLabelText(/team name/i)).not.toBeInTheDocument();
  });
});
