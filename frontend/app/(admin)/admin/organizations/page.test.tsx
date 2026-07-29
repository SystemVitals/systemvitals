import { MockedProvider } from "@apollo/client/testing/react";
import { render, screen } from "@testing-library/react";
import { print } from "graphql";
import { describe, expect, it } from "vitest";

import { ADMIN_ORGANIZATIONS } from "@/lib/admin-queries";
import AdminOrganizationsPage from "./page";

const internalDefaultProject = {
  id: "project-default",
  name: "Default",
};

describe("AdminOrganizationsPage", () => {
  it("summarizes organizations by members without exposing internal projects", async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: {
              query: ADMIN_ORGANIZATIONS,
              variables: { search: undefined, page: 0, pageSize: 20 },
            },
            result: {
              data: {
                adminOrganizations: {
                  items: [
                    {
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
                        {
                          userId: "user-2",
                          email: "member@example.com",
                          role: "MEMBER",
                        },
                      ],
                      internalProjects: [internalDefaultProject],
                    },
                  ],
                  total: 1,
                },
              },
            },
          },
        ]}
      >
        <AdminOrganizationsPage />
      </MockedProvider>,
    );

    expect(await screen.findByText("Operations")).toBeInTheDocument();
    expect(screen.getByText(/2 members/i)).toBeInTheDocument();
    expect(screen.queryByText(/projects?/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
  });

  it("does not request projectCount", () => {
    expect(print(ADMIN_ORGANIZATIONS)).not.toContain("projectCount");
  });
});
