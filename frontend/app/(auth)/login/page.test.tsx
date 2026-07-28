import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockPush,
  mockReplace,
  mockRouter,
  getSearchParams,
  setSearchParams,
  mockLogin,
} = vi.hoisted(() => {
  let params = new URLSearchParams("");
  const push = vi.fn();
  const replace = vi.fn();
  return {
    mockPush: push,
    mockReplace: replace,
    // Next.js's real useRouter() returns a stable object identity across
    // renders. A new literal here would (like the original bug) make any
    // effect depending on `router` re-run every render.
    mockRouter: { push, replace },
    // Next.js's real useSearchParams() returns a *new* object identity on
    // every render (even when the content hasn't changed). This mock hands
    // back a fresh URLSearchParams built from the current `params` on every
    // call, matching that behavior. The `params` only change when a test
    // explicitly calls setSearchParams; `replace()` alone (recorded, not
    // wired up) never clears it.
    getSearchParams: () => new URLSearchParams(params.toString()),
    setSearchParams: (next: URLSearchParams) => {
      params = next;
    },
    mockLogin: vi.fn(),
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => getSearchParams(),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ login: mockLogin }),
}));

import LoginPage from "./page";

describe("LoginPage", () => {
  beforeEach(() => {
    setSearchParams(new URLSearchParams(""));
    mockPush.mockClear();
    mockReplace.mockClear();
    mockLogin.mockReset().mockResolvedValue(undefined);
  });

  it("renders a Google sign-in link pointing at the API", () => {
    render(<LoginPage />);
    const link = screen.getByRole("link", { name: /continue with google/i });
    expect(link).toHaveAttribute("href", "http://localhost:8888/auth/google");
  });

  it("does not wrap the footer in a bordered tray", () => {
    const { container } = render(<LoginPage />);
    const footer = container.querySelector('[data-slot="card-footer"]');
    expect(footer).not.toBeNull();
    expect(footer?.className).toContain("border-t-0");
    expect(footer?.className).not.toContain("pt-2");
    expect(footer?.className).toContain("pt-(--card-spacing)");
    expect(footer?.className).not.toContain("pt-0");
  });

  describe("Google sign-in error dialog", () => {
    it("shows the error dialog when ?error=google is present", async () => {
      setSearchParams(new URLSearchParams("error=google"));
      render(<LoginPage />);

      const dialog = await screen.findByRole("dialog");
      expect(dialog).toBeInTheDocument();
      expect(
        screen.getByText(/couldn't sign you in with google/i)
      ).toBeInTheDocument();
    });

    it("stays closed after the user dismisses it", async () => {
      setSearchParams(new URLSearchParams("error=google"));
      render(<LoginPage />);

      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // Give any stray re-triggered effect a chance to fire, then confirm
      // the dialog is still gone — this is the regression check.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("does not re-surface the error on a subsequent render after dismiss", async () => {
      // This test verifies that the `handled` ref prevents the effect from
      // re-firing when a subsequent render occurs. While router.replace()
      // clears the param in real use, this test explicitly models a scenario
      // where the next render still sees ?error=google. The one-shot guard
      // must prevent a re-surface.
      setSearchParams(new URLSearchParams("error=google"));
      const { rerender } = render(<LoginPage />);

      await screen.findByRole("dialog");
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });

      // router.replace() ran, but (per the mock above) the params the next
      // render sees are still the stale ?error=google ones — simulate that
      // next render explicitly.
      expect(mockReplace).toHaveBeenCalledWith("/login");
      rerender(<LoginPage />);

      // Let any stray re-triggered effect's deferred microtask fire, then
      // confirm the dialog never came back.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("does not show a dialog when there is no error param", () => {
      render(<LoginPage />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("clears the error query param from the URL once surfaced", async () => {
      setSearchParams(new URLSearchParams("error=google"));
      render(<LoginPage />);

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith("/login");
      });
    });
  });

  describe("post-login redirect via ?next=", () => {
    async function submitLoginForm() {
      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: "invitee@example.com" },
      });
      fireEvent.change(screen.getByLabelText(/password/i), {
        target: { value: "correct-horse-battery-staple" },
      });
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
      await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    }

    // Dropping the `nextPathRef`/`safeNext` wiring and always replacing with
    // "/dashboard" makes this fail because the validated invite path is lost.
    it("replaces with a validated ?next= path after a successful login", async () => {
      setSearchParams(new URLSearchParams("next=/invite/tok1"));
      render(<LoginPage />);

      await submitLoginForm();

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith("/invite/tok1");
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("falls back to /dashboard when there is no ?next= param", async () => {
      render(<LoginPage />);

      await submitLoginForm();

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith("/dashboard");
      });
      expect(mockPush).not.toHaveBeenCalled();
    });

    // Open-redirect guard: this is the assertion that fails if `safeNext`'s
    // same-origin validation is dropped (e.g. accepting any non-empty
    // string) — it would navigate to the attacker-supplied absolute URL
    // instead of falling back to "/dashboard".
    it("never redirects off-site for a hostile ?next= value", async () => {
      setSearchParams(new URLSearchParams("next=https://evil.com"));
      render(<LoginPage />);

      await submitLoginForm();

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith("/dashboard");
      });
      expect(mockReplace).not.toHaveBeenCalledWith("https://evil.com");
      expect(mockPush).not.toHaveBeenCalled();
    });

    it("replaces a token-bearing login URL exactly once under Strict Mode", async () => {
      const destination =
        "/channels/telegram/connect?token=history-sensitive-challenge";
      setSearchParams(new URLSearchParams({ next: destination }));
      render(
        <StrictMode>
          <LoginPage />
        </StrictMode>,
      );

      await submitLoginForm();

      await waitFor(() => {
        expect(mockReplace).toHaveBeenCalledWith(destination);
      });
      expect(mockReplace).toHaveBeenCalledOnce();
      expect(mockPush).not.toHaveBeenCalled();
    });
  });
});
