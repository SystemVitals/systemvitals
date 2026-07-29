import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  OrgProvider,
  useOrg,
  ACTIVE_ORG_STORAGE_KEY,
  type Org,
} from "./org-context";

const orgs = [
  {
    id: "org1",
    name: "First",
    slug: "first",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "user-1",
    creatorLabel: "owner@example.com",
    pingKey: "ping-1",
  },
  {
    id: "org2",
    name: "Second",
    slug: "second",
    role: "MEMBER",
    plan: "SOLO",
    creatorUserId: "user-2",
    creatorLabel: "creator@example.com",
    pingKey: "ping-2",
  },
] satisfies Org[];

let mockOrgs = orgs;

vi.mock("./auth-context", () => ({
  useAuth: () => ({ user: { organizations: mockOrgs } }),
}));

function Probe() {
  const { activeOrg, setActiveOrgId } = useOrg();
  return (
    <div>
      <span data-testid="active">{activeOrg?.name ?? "none"}</span>
      <span data-testid="ping-key">{activeOrg?.pingKey ?? "none"}</span>
      <button onClick={() => setActiveOrgId("org2")}>switch</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <OrgProvider>
      <Probe />
    </OrgProvider>,
  );
}

describe("OrgProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    mockOrgs = orgs;
  });

  it("defaults to the first organization", () => {
    renderProbe();
    expect(screen.getByTestId("active").textContent).toBe("First");
    expect(screen.getByTestId("ping-key").textContent).toBe("ping-1");
  });

  it("persists the active organization to localStorage", () => {
    renderProbe();
    fireEvent.click(screen.getByText("switch"));
    expect(screen.getByTestId("active").textContent).toBe("Second");
    expect(screen.getByTestId("ping-key").textContent).toBe("ping-2");
    expect(localStorage.getItem(ACTIVE_ORG_STORAGE_KEY)).toBe("org2");
  });

  it("restores the stored organization on mount", () => {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, "org2");
    renderProbe();
    expect(screen.getByTestId("active").textContent).toBe("Second");
  });

  it("ignores a stored organization the user no longer belongs to", () => {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, "deleted-org");
    renderProbe();
    expect(screen.getByTestId("active").textContent).toBe("First");
  });

  // The test above alone does not prove self-healing: with storedId never read
  // at all, `orgs.find(o => o.id === null)` is also undefined, so it would fall
  // back to orgs[0] and pass anyway. This one starts from a stored org that IS
  // honoured, then takes it away — so it can only pass if the stored id is
  // genuinely read AND the fallback genuinely fires.
  it("self-heals when access to the active organization is lost", () => {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, "org2");
    const { rerender } = renderProbe();
    expect(screen.getByTestId("active").textContent).toBe("Second");

    // Invite revoked / member removed / org deleted: org2 disappears from `me`.
    mockOrgs = [orgs[0]];
    rerender(
      <OrgProvider>
        <Probe />
      </OrgProvider>,
    );

    expect(screen.getByTestId("active").textContent).toBe("First");
  });

  it("reports no active organization when the user has none", () => {
    mockOrgs = [];
    renderProbe();
    expect(screen.getByTestId("active").textContent).toBe("none");
  });
});
