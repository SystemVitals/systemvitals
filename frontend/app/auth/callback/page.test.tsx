import { render, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const loginWithToken = vi.fn(() => Promise.resolve());
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ loginWithToken }),
}));

let mockSearch = "";

import CallbackPage from "./page";

describe("/auth/callback", () => {
  beforeEach(() => {
    replace.mockClear();
    loginWithToken.mockClear();
    loginWithToken.mockResolvedValue(undefined);
  });

  it("stores the token and lands on the dashboard", async () => {
    mockSearch = "token=abc.def.ghi";
    render(<CallbackPage />);

    await waitFor(() => {
      expect(loginWithToken).toHaveBeenCalledWith("abc.def.ghi");
    });
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("bounces to login when the token is missing", async () => {
    mockSearch = "";
    render(<CallbackPage />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login?error=google");
    });
    expect(loginWithToken).not.toHaveBeenCalled();
  });

  it("bounces to login when the token is rejected", async () => {
    mockSearch = "token=stale";
    loginWithToken.mockRejectedValueOnce(new Error("nope"));
    render(<CallbackPage />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/login?error=google");
    });
  });
});
