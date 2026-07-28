import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockPush, mockRouter, getSearchParams, setSearchParams, mockSignup } =
  vi.hoisted(() => {
    let params = new URLSearchParams("");
    const push = vi.fn();
    return {
      mockPush: push,
      // Next.js's real useRouter() returns a stable object identity across
      // renders. A new literal here would make any effect depending on
      // `router` re-run every render.
      mockRouter: { push, replace: vi.fn() },
      // Next.js's real useSearchParams() returns a *new* object identity on
      // every render (even when the content hasn't changed). This mock hands
      // back a fresh URLSearchParams built from the current `params` on
      // every call, matching that behavior.
      getSearchParams: () => new URLSearchParams(params.toString()),
      setSearchParams: (next: URLSearchParams) => {
        params = next;
      },
      mockSignup: vi.fn(),
    };
  });

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => getSearchParams(),
}));
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ signup: mockSignup }),
}));

import SignupPage from "./page";

describe("SignupPage", () => {
  beforeEach(() => {
    setSearchParams(new URLSearchParams(""));
    mockPush.mockClear();
    mockSignup.mockReset().mockResolvedValue(undefined);
  });

  it("renders a Google sign-in link pointing at the API", () => {
    render(<SignupPage />);
    const link = screen.getByRole("link", { name: /continue with google/i });
    expect(link).toHaveAttribute("href", "http://localhost:8888/auth/google");
  });

  it("links to the Terms and Privacy Policy before account creation", () => {
    render(<SignupPage />);

    expect(screen.getByRole("link", { name: "Terms" })).toHaveAttribute(
      "href",
      "/terms"
    );
    expect(screen.getByRole("link", { name: "Privacy Policy" })).toHaveAttribute(
      "href",
      "/privacy"
    );
  });

  describe("post-signup redirect via ?next=", () => {
    async function submitSignupForm() {
      fireEvent.change(screen.getByLabelText(/email/i), {
        target: { value: "invitee@example.com" },
      });
      fireEvent.change(screen.getByLabelText(/password/i), {
        target: { value: "correct-horse-battery-staple" },
      });
      fireEvent.click(screen.getByRole("button", { name: /create account/i }));
      await waitFor(() => expect(mockSignup).toHaveBeenCalled());
    }

    // This is the fix under test: dropping the `nextPathRef`/`safeNext`
    // wiring (i.e. always calling `router.push("/dashboard")`) makes this
    // assertion fail, since it would push "/dashboard" instead of the
    // invite path -- the exact regression this task fixes (a new user
    // signing up off an invite link never returning to accept it).
    it("redirects to a validated ?next= path after a successful signup", async () => {
      setSearchParams(new URLSearchParams("next=/invite/tok1"));
      render(<SignupPage />);

      await submitSignupForm();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith("/invite/tok1");
      });
    });

    it("falls back to /dashboard when there is no ?next= param", async () => {
      render(<SignupPage />);

      await submitSignupForm();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith("/dashboard");
      });
    });

    // Open-redirect guard: this is the assertion that fails if `safeNext`'s
    // same-origin validation is dropped -- it would push the
    // attacker-supplied absolute URL instead of falling back to
    // "/dashboard".
    it("never redirects off-site for a hostile ?next= value", async () => {
      setSearchParams(new URLSearchParams("next=https://evil.com"));
      render(<SignupPage />);

      await submitSignupForm();

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith("/dashboard");
      });
      expect(mockPush).not.toHaveBeenCalledWith("https://evil.com");
    });
  });
});
