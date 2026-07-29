import { MockedProvider } from "@apollo/client/testing/react";
import { render, screen } from "@testing-library/react";
import { print } from "graphql";
import { describe, expect, it, vi } from "vitest";

import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { ADMIN_METRICS } from "@/lib/admin-queries";
import AdminOverviewPage from "./page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin",
}));

const internalDefaultProject = {
  id: "project-default",
  name: "Default",
};

const metricsMock = {
  request: { query: ADMIN_METRICS },
  result: {
    data: {
      adminMetrics: {
        totalUsers: 12,
        totalOrgs: 4,
        totalProjects: 99,
        totalChecks: 17,
        alertsLast24h: 3,
        checksByStatus: [{ status: "UP", count: 17 }],
        recentSignups: [],
        signupsPerDay: [],
        internalProject: internalDefaultProject,
      },
    },
  },
};

describe("AdminOverviewPage", () => {
  it("shows organization and check metrics without the internal project metric", async () => {
    render(
      <MockedProvider mocks={[metricsMock]}>
        <AdminOverviewPage />
      </MockedProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Platform overview" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Organizations")).toBeInTheDocument();
    expect(screen.getAllByText("Checks").length).toBeGreaterThan(0);
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText("99")).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("does not request the deprecated totalProjects metric", () => {
    expect(print(ADMIN_METRICS)).not.toContain("totalProjects");
  });
});

describe("AdminSidebar", () => {
  it("labels the resource navigation Checks without project terminology", () => {
    render(<AdminSidebar />);

    expect(
      screen.getByRole("link", { name: "Checks" }),
    ).toHaveAttribute("href", "/admin/checks");
    expect(
      screen.queryByRole("link", { name: /projects/i }),
    ).not.toBeInTheDocument();
  });
});
