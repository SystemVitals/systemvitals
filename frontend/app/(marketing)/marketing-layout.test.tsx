import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: null, loading: false }) }));

import { MarketingNav } from "@/components/marketing/nav";

describe("MarketingNav", () => {
  it("shows Login and Sign up when logged out, and never throws without auth", () => {
    render(<MarketingNav />);
    expect(screen.getByText("Login")).toBeTruthy();
    expect(screen.getByText(/sign up|start free/i)).toBeTruthy();
  });
});
