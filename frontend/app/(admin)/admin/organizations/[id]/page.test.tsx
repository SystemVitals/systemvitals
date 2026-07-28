import { MockedProvider } from "@apollo/client/testing/react";
import { render, screen } from "@testing-library/react";
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

describe("AdminOrganizationDetailPage", () => {
  it("shows the inherited plan read-only and directs plan management to accounts", async () => {
    render(
      <MockedProvider
        mocks={[
          {
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
                },
              },
            },
          },
        ]}
      >
        <AdminOrganizationDetailPage />
      </MockedProvider>,
    );

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
});
