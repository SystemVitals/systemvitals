import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/admin" }));
let mockUser: { isAdmin: boolean } | null = { isAdmin: false };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: mockUser, loading: false }) }));

import AdminLayout from "./layout";

describe("admin gate", () => {
  it("redirects a non-admin away from /admin", () => {
    mockUser = { isAdmin: false };
    render(<AdminLayout><div>secret</div></AdminLayout>);
    expect(push).toHaveBeenCalledWith("/dashboard");
    expect(screen.queryByText("secret")).toBeNull();
  });
});
