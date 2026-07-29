import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MockedResponse } from "@apollo/client/testing";
import { MockedProvider } from "@apollo/client/testing/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECKS,
  CREATE_STATUS_PAGE,
  STATUS_PAGES,
} from "@/lib/queries";
import StatusPagesPage from "./page";

let activeOrg: {
  id: string;
  name: string;
  slug: string;
  role: string;
  plan: string;
  creatorUserId: string;
  creatorLabel: string;
  pingKey: string;
} | null;

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: { id: "user-1", email: "ops@example.com" },
  }),
}));

vi.mock("@/lib/org-context", () => ({
  useOrg: () => ({ activeOrg }),
}));

function statusPagesMock(
  organizationId: string,
  pages: Array<{
    id: string;
    slug: string;
    title: string;
    checkIds: string[];
  }> = []
): MockedResponse {
  return {
    request: {
      query: STATUS_PAGES,
      variables: { organizationId },
    },
    result: {
      data: {
        statusPages: pages.map((page) => ({
          ...page,
          organizationId,
        })),
      },
    },
  };
}

function checksMock(organizationId: string): MockedResponse {
  return {
    request: {
      query: CHECKS,
      variables: { organizationId },
    },
    result: { data: { checks: [] } },
  };
}

function renderPage(mocks: MockedResponse[]) {
  return render(
    <MockedProvider mocks={mocks}>
      <StatusPagesPage />
    </MockedProvider>
  );
}

describe("StatusPagesPage", () => {
  beforeEach(() => {
    activeOrg = {
      id: "org-1",
      name: "Operations",
      slug: "operations",
      role: "OWNER",
      plan: "SOLO",
      creatorUserId: "user-1",
      creatorLabel: "ops@example.com",
      pingKey: "ping-1",
    };
  });

  it("loads the active organization and links to the canonical public URL", async () => {
    renderPage([
      statusPagesMock("org-1", [
        {
          id: "page-1",
          slug: "system-status",
          title: "System status",
          checkIds: [],
        },
      ]),
      checksMock("org-1"),
    ]);

    const link = await screen.findByTitle("Open status page");
    expect(link).toHaveAttribute("href", "/status/system-status");
    expect(screen.getByText(/status\/system-status/)).toBeInTheDocument();
    expect(screen.queryByText(/project/i)).not.toBeInTheDocument();
  });

  it("creates a status page in the active organization", async () => {
    const createResult = vi.fn(() => ({
      data: {
        createStatusPage: {
          id: "page-2",
          organizationId: "org-1",
          slug: "public-status",
        },
      },
    }));

    renderPage([
      statusPagesMock("org-1"),
      checksMock("org-1"),
      {
        request: {
          query: CREATE_STATUS_PAGE,
          variables: {
            organizationId: "org-1",
            slug: "public-status",
            title: "Public status",
            checkIds: [],
          },
        },
        result: createResult,
      },
      statusPagesMock("org-1"),
    ]);

    fireEvent.change(await screen.findByLabelText("Slug"), {
      target: { value: "public-status" },
    });
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Public status" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create status page" }));

    await waitFor(() => expect(createResult).toHaveBeenCalledOnce());
  });

  it("reloads status pages and checks when the active organization changes", async () => {
    const secondPagesResult = vi.fn(() => ({
      data: {
        statusPages: [
          {
            id: "page-2",
            organizationId: "org-2",
            slug: "beta-status",
            title: "Beta status",
            checkIds: [],
          },
        ],
      },
    }));
    const secondChecksResult = vi.fn(() => ({ data: { checks: [] } }));
    const mocks = [
      statusPagesMock("org-1"),
      checksMock("org-1"),
      {
        request: {
          query: STATUS_PAGES,
          variables: { organizationId: "org-2" },
        },
        result: secondPagesResult,
      },
      {
        request: {
          query: CHECKS,
          variables: { organizationId: "org-2" },
        },
        result: secondChecksResult,
      },
    ];
    const view = renderPage(mocks);

    expect(await screen.findByText("No status pages yet.")).toBeInTheDocument();
    activeOrg = {
      ...activeOrg!,
      id: "org-2",
      name: "Beta",
      slug: "beta",
      pingKey: "ping-2",
    };
    view.rerender(
      <MockedProvider mocks={mocks}>
        <StatusPagesPage />
      </MockedProvider>
    );

    expect(await screen.findByText("Beta status")).toBeInTheDocument();
    expect(secondPagesResult).toHaveBeenCalledOnce();
    await waitFor(() => expect(secondChecksResult).toHaveBeenCalledOnce());
  });

  it("shows an organization empty state without issuing queries", () => {
    activeOrg = null;
    renderPage([]);

    expect(screen.getByText("No organizations found.")).toBeInTheDocument();
  });
});
