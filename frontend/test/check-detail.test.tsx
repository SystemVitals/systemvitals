import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import { print } from "graphql";
import { CheckDetail, type CheckDetailData } from "@/components/app/check-detail";
import { CHECK, CHECK_BY_SLUG } from "@/lib/queries";
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
    projects: [{ id: "project-1", name: "Source", slug: "source", pingKey: "source" }],
  },
  {
    id: "org-destination",
    name: "Destination Org",
    slug: "destination",
    role: "OWNER",
    plan: "SOLO",
    creatorUserId: "creator-destination",
    creatorLabel: "destination@example.com",
    projects: [
      {
        id: "project-destination",
        name: "Production",
        slug: "production",
        pingKey: "production",
      },
    ],
  },
] satisfies Org[];

const CHECK_DATA: CheckDetailData = {
  id: "c1",
  projectId: "project-1",
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

function renderDetail(props: Partial<Parameters<typeof CheckDetail>[0]> = {}) {
  return render(
    <MockedProvider mocks={[]}>
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

  it("loads projectId on both direct check routes", () => {
    expect(print(CHECK)).toContain("projectId");
    expect(print(CHECK_BY_SLUG)).toContain("projectId");
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

  it("shows move check when another owned organization has a project", () => {
    renderDetail({ onMoved: vi.fn() });

    expect(screen.getByRole("button", { name: "Move check" })).toBeInTheDocument();
  });

  it("hides move check when the only destination organization is admin", () => {
    orgContext.orgs = [ORGS[0], { ...ORGS[1], role: "ADMIN" }];

    renderDetail({ onMoved: vi.fn() });

    expect(screen.queryByRole("button", { name: "Move check" })).not.toBeInTheDocument();
  });
});
