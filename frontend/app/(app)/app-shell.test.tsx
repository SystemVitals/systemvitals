import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { MockedProvider } from "@apollo/client/testing/react";

const push = vi.fn();
const replace = vi.fn();
const router = { push, replace };
let pathname = "/dashboard";
let mockUser: { id: string; email: string } | null = {
  id: "u1",
  email: "a@b.c",
};
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => pathname,
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({
    user: mockUser,
    loading: false,
    logout: vi.fn(),
    refetchMe: vi.fn().mockResolvedValue(undefined),
  }),
}));

import AppLayout from "./layout";

describe("App shell", () => {
  beforeEach(() => {
    pathname = "/dashboard";
    mockUser = { id: "u1", email: "a@b.c" };
    push.mockClear();
    replace.mockClear();
    window.history.replaceState({}, "", "/dashboard");
  });

  it("renders sidebar nav for an authenticated user", () => {
    render(
      <MockedProvider>
        <AppLayout><div>content</div></AppLayout>
      </MockedProvider>,
    );
    expect(screen.getByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("Channels")).toBeTruthy();
    expect(screen.getByText("content")).toBeTruthy();
  });

  it("marks only Agent connections active in the mobile drawer on its nested route", () => {
    pathname = "/account/agent-connections";
    render(
      <MockedProvider>
        <AppLayout><div>content</div></AppLayout>
      </MockedProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Menu" }));
    const drawer = screen.getByRole("dialog", { name: "Navigation menu" });
    expect(drawer).toHaveClass("max-h-[calc(100dvh-2rem)]", "overflow-y-auto");
    const account = within(drawer).getByRole("link", { name: "Account" });
    const agentConnections = within(drawer).getByRole("link", {
      name: "Agent connections",
    });

    expect(account).not.toHaveClass("text-primary");
    expect(agentConnections).toHaveClass("text-primary");
  });

  it("redirects an unauthenticated dashboard visit through login with an encoded next path", async () => {
    mockUser = null;

    render(
      <MockedProvider>
        <AppLayout><div>content</div></AppLayout>
      </MockedProvider>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login?next=%2Fdashboard");
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });

  it("replaces a Telegram challenge URL exactly once under Strict Mode", async () => {
    mockUser = null;
    pathname = "/channels/telegram/connect";
    window.history.replaceState(
      {},
      "",
      "/channels/telegram/connect?token=test-challenge",
    );

    render(
      <StrictMode>
        <MockedProvider>
          <AppLayout><div>content</div></AppLayout>
        </MockedProvider>
      </StrictMode>,
    );

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith(
        "/login?next=%2Fchannels%2Ftelegram%2Fconnect%3Ftoken%3Dtest-challenge",
      );
    });
    expect(replace).toHaveBeenCalledOnce();
    expect(push).not.toHaveBeenCalled();
  });
});
