import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1", email: "admin@example.com" }, loading: false }),
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

import { ImpersonationBanner } from "./impersonation-banner";

/** Mint a fake JWT with a given payload. */
function mintJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${header}.${body}.fakesig`;
}

describe("ImpersonationBanner", () => {
  beforeEach(() => localStorage.clear());

  it("does NOT render when sv_admin_token is absent", async () => {
    const { container } = render(<ImpersonationBanner />);
    // Wait a tick for deferred setState
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("does NOT render when sv_admin_token is set but sv_token has no act field", async () => {
    // sv_admin_token is set, but the active sv_token has no act claim
    localStorage.setItem("sv_admin_token", mintJwt({ sub: "admin1", email: "admin@example.com" }));
    localStorage.setItem("sv_token", mintJwt({ sub: "admin1", email: "admin@example.com" }));

    const { container } = render(<ImpersonationBanner />);
    await waitFor(() => {
      expect(container.firstChild).toBeNull();
    });
  });

  it("DOES render when sv_admin_token is set AND sv_token has an act claim", async () => {
    localStorage.setItem("sv_admin_token", mintJwt({ sub: "admin1", email: "admin@example.com" }));
    localStorage.setItem(
      "sv_token",
      mintJwt({ sub: "victim1", email: "victim@example.com", act: "admin1" }),
    );

    render(<ImpersonationBanner />);
    await waitFor(() => {
      expect(screen.getByText("victim@example.com")).toBeInTheDocument();
    });
    expect(screen.getByText("Exit")).toBeInTheDocument();
  });
});
