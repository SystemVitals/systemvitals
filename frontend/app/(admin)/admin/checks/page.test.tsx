import { MockedProvider } from "@apollo/client/testing/react";
import { render, screen } from "@testing-library/react";
import { print } from "graphql";
import { describe, expect, it } from "vitest";

import { ADMIN_CHECKS } from "@/lib/admin-queries";
import AdminChecksPage from "./page";

describe("AdminChecksPage", () => {
  it("shows organization ownership without the internal Default project", async () => {
    render(
      <MockedProvider
        mocks={[
          {
            request: {
              query: ADMIN_CHECKS,
              variables: { status: undefined, page: 0, pageSize: 20 },
            },
            result: {
              data: {
                adminChecks: {
                  items: [
                    {
                      id: "check-1",
                      name: "Nightly backup",
                      type: "HEARTBEAT",
                      status: "UP",
                      projectId: "project-default",
                      projectName: "Default",
                      organizationId: "organization-1",
                      organizationName: "Operations",
                    },
                  ],
                  total: 1,
                },
              },
            },
          },
        ]}
      >
        <AdminChecksPage />
      </MockedProvider>,
    );

    expect(await screen.findByText("Nightly backup")).toBeInTheDocument();
    expect(screen.getByText("Operations")).toBeInTheDocument();
    expect(screen.queryByText("Default")).not.toBeInTheDocument();
    expect(screen.queryByText(/Operations \//)).not.toBeInTheDocument();
  });

  it("does not request project IDs or names", () => {
    const source = print(ADMIN_CHECKS);
    expect(source).not.toContain("projectId");
    expect(source).not.toContain("projectName");
  });
});
