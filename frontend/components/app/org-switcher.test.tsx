import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { OrgSwitcher } from "./org-switcher";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ refetchMe: vi.fn().mockResolvedValue(undefined) }),
}));

const setActiveOrgId = vi.fn();
let mockCtx = {
  orgs: [{ id: "org1", name: "First", role: "OWNER", plan: "SOLO", projects: [] }],
  activeOrg: { id: "org1", name: "First", role: "OWNER", plan: "SOLO", projects: [] },
  activeOrgId: "org1",
  setActiveOrgId,
};

vi.mock("@/lib/org-context", () => ({
  useOrg: () => mockCtx,
}));

function renderSwitcher() {
  return render(
    <MockedProvider>
      <OrgSwitcher />
    </MockedProvider>,
  );
}

describe("OrgSwitcher", () => {
  it("shows the current organization and a New organization action for a single-org user", () => {
    mockCtx = {
      orgs: [{ id: "org1", name: "First", role: "OWNER", plan: "SOLO", projects: [] }],
      activeOrg: { id: "org1", name: "First", role: "OWNER", plan: "SOLO", projects: [] },
      activeOrgId: "org1",
      setActiveOrgId,
    };
    renderSwitcher();
    expect(
      screen.getByRole("button", { name: /new organization/i }),
    ).toBeInTheDocument();
    // The workspace is always named so pages are clearly scoped...
    expect(screen.getByText("First")).toBeInTheDocument();
    // ...but there is no org Select for a single-org user.
    expect(screen.queryByLabelText(/organization/i)).not.toBeInTheDocument();
  });

  it("renders the active organization name when there are several", () => {
    const orgs = [
      { id: "org1", name: "First", role: "OWNER", plan: "SOLO", projects: [] },
      { id: "org2", name: "Second", role: "MEMBER", plan: "SOLO", projects: [] },
    ];
    mockCtx = {
      orgs,
      activeOrg: orgs[0],
      activeOrgId: "org1",
      setActiveOrgId,
    };

    renderSwitcher();

    expect(screen.getByLabelText(/organization/i)).toBeInTheDocument();
    expect(screen.getByText("First")).toBeInTheDocument();
    // ...and the New organization action is still present alongside the Select.
    expect(
      screen.getByRole("button", { name: /new organization/i }),
    ).toBeInTheDocument();
  });
});
