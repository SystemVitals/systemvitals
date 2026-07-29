import { MockedProvider } from "@apollo/client/testing/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { print } from "graphql";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_ORGANIZATION } from "@/lib/admin-queries";
import AdminOrganizationDetailPage from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "organization-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const internalDefaultProject = {
  id: "project-default",
  name: "Default",
};

function organizationMock() {
  return {
    request: {
      query: ADMIN_ORGANIZATION,
      variables: { id: "organization-1" },
    },
    result: {
      data: {
        adminOrganization: {
          id: "organization-1",
          name: "Operations",
          createdAt: "2026-07-23T00:00:00.000Z",
          projectCount: 1,
          plan: "SIGNAL",
          members: [
            {
              userId: "user-1",
              email: "owner@example.com",
              role: "OWNER",
            },
          ],
          internalProjects: [internalDefaultProject],
        },
      },
    },
  };
}

function renderPage() {
  return render(
    <MockedProvider mocks={[organizationMock()]}>
      <AdminOrganizationDetailPage />
    </MockedProvider>,
  );
}

describe("AdminOrganizationDetailPage", () => {
  it("shows the inherited plan read-only and directs plan management to accounts", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Operations" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("SIGNAL").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/inherited from the creator account/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Plan override")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /save plan/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /manage account subscriptions/i }),
    ).toHaveAttribute("href", "/admin/subscriptions");
  });

  it("shows member details without project counts or the internal project", async () => {
    renderPage();

    expect(
      await screen.findByRole("heading", { name: "Operations" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Members")).toBeInTheDocument();
    expect(screen.queryByText("Projects")).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("warns about all organization data without exposing projects", async () => {
    renderPage();
    await screen.findByRole("heading", { name: "Operations" });

    fireEvent.click(
      screen.getByRole("button", { name: "Delete organization" }),
    );

    const warning = await screen.findByText(
      /checks, notification channels, status pages, members, and data/i,
    );
    expect(warning).toBeInTheDocument();
    expect(screen.queryByText(/projects?/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("does not request projectCount", () => {
    expect(print(ADMIN_ORGANIZATION)).not.toContain("projectCount");
  });
});
