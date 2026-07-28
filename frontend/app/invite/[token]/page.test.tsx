import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MockedProvider } from "@apollo/client/testing/react";
import type { MockedResponse } from "@apollo/client/testing";
import { GraphQLError } from "graphql";
import InvitePage from "./page";
import { INVITE_PREVIEW, ACCEPT_INVITE } from "@/lib/queries";

let mockUser: { email: string } | null = null;
let mockAuthLoading = false;
const mockRefetchMe = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: mockUser,
    loading: mockAuthLoading,
    refetchMe: mockRefetchMe,
  }),
}));

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "tok1" }),
  useRouter: () => ({ push: mockPush }),
}));

function mockPreview(status: string, maskedEmail = "i***@example.com") {
  return [
    {
      request: { query: INVITE_PREVIEW, variables: { token: "tok1" } },
      result: {
        data: {
          invitePreview: {
            organizationName: "Acme",
            maskedEmail,
            status,
          },
        },
      },
    },
  ];
}

function renderPage(status: string, extraMocks: MockedResponse[] = []) {
  return render(
    <MockedProvider
      mocks={[...mockPreview(status), ...extraMocks]}
    >
      <InvitePage />
    </MockedProvider>,
  );
}

describe("InvitePage", () => {
  beforeEach(() => {
    mockUser = null;
    mockAuthLoading = false;
    mockRefetchMe.mockClear();
    mockPush.mockClear();
  });

  it("prompts a logged-out visitor to sign in", async () => {
    renderPage("PENDING");
    expect((await screen.findAllByText(/Acme/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /log in/i })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /accept/i }),
    ).not.toBeInTheDocument();
  });

  it("offers to accept when logged in", async () => {
    mockUser = { email: "invitee@example.com" };
    renderPage("PENDING");
    expect(
      await screen.findByRole("button", { name: /accept/i }),
    ).toBeInTheDocument();
  });

  it("explains an expired invite and offers no accept button", async () => {
    mockUser = { email: "invitee@example.com" };
    renderPage("EXPIRED");
    expect(await screen.findByText(/expired/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /accept/i }),
    ).not.toBeInTheDocument();
  });

  it("explains a revoked invite", async () => {
    mockUser = { email: "invitee@example.com" };
    renderPage("REVOKED");
    expect(await screen.findByText(/revoked|no longer valid/i)).toBeInTheDocument();
  });

  it("explains an unknown token", async () => {
    renderPage("NOT_FOUND");
    expect(await screen.findByText(/not find this invite/i)).toBeInTheDocument();
  });

  it("explains that the invite was already accepted, with no accept button", async () => {
    mockUser = { email: "invitee@example.com" };
    renderPage("ACCEPTED");
    expect(
      await screen.findByText(/already been accepted/i),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /accept/i }),
    ).not.toBeInTheDocument();
  });

  it("does not show the logged-out Log in / Sign up branch while auth is still loading", async () => {
    mockUser = null;
    mockAuthLoading = true;
    renderPage("PENDING");
    expect((await screen.findAllByText(/Acme/)).length).toBeGreaterThan(0);
    expect(
      screen.queryByRole("link", { name: /log in/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /sign up/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /accept/i }),
    ).not.toBeInTheDocument();
  });

  it("accepts the invite, refetches the auth context, and redirects to /team", async () => {
    mockUser = { email: "invitee@example.com" };
    const acceptMock = {
      request: { query: ACCEPT_INVITE, variables: { token: "tok1" } },
      result: {
        data: {
          acceptInvite: {
            id: "m1",
            email: "invitee@example.com",
            role: "MEMBER",
          },
        },
      },
    };

    // Delay refetchMe's resolution so the test can prove the navigation is
    // genuinely awaited: with a fire-and-forget `void refetchMe()`, push would
    // fire immediately and this ordering assertion would fail.
    let resolveRefetch: () => void = () => {};
    mockRefetchMe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRefetch = resolve;
        }),
    );

    renderPage("PENDING", [acceptMock]);

    fireEvent.click(
      await screen.findByRole("button", { name: /accept invite/i }),
    );

    await waitFor(() => {
      expect(mockRefetchMe).toHaveBeenCalledTimes(1);
    });
    // refetchMe is in flight and has NOT resolved — the redirect must wait.
    expect(mockPush).not.toHaveBeenCalled();

    await act(async () => {
      resolveRefetch();
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/team");
    });
  });

  it("still redirects to /team when the post-accept refetch fails", async () => {
    // The invite is accepted server-side before refetchMe runs, so a refetch
    // blip must not strand the user on a dead invite page.
    mockUser = { email: "invitee@example.com" };
    mockRefetchMe.mockRejectedValueOnce(new Error("network blip"));
    const acceptMock = {
      request: { query: ACCEPT_INVITE, variables: { token: "tok1" } },
      result: {
        data: {
          acceptInvite: { id: "m1", email: "invitee@example.com", role: "MEMBER" },
        },
      },
    };

    renderPage("PENDING", [acceptMock]);

    fireEvent.click(
      await screen.findByRole("button", { name: /accept invite/i }),
    );

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/team");
    });
  });

  it("surfaces an email-mismatch rejection in the error dialog", async () => {
    mockUser = { email: "wrong@example.com" };
    const acceptMock = {
      request: { query: ACCEPT_INVITE, variables: { token: "tok1" } },
      result: {
        errors: [
          new GraphQLError(
            "This invite was sent to a different email address",
          ),
        ],
      },
    };

    renderPage("PENDING", [acceptMock]);

    fireEvent.click(
      await screen.findByRole("button", { name: /accept invite/i }),
    );

    expect(
      await screen.findByText(
        "This invite was sent to a different email address",
      ),
    ).toBeInTheDocument();
    expect(mockPush).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  });
});
