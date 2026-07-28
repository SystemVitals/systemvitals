import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";

const setPassword = vi.fn().mockResolvedValue({ data: { setPassword: true } });
vi.mock("@apollo/client/react", () => ({
  useMutation: () => [setPassword, { loading: false }],
}));

let mockUser = {
  id: "u1",
  email: "ada@example.com",
  isAdmin: false,
  hasPassword: false,
  googleLinked: true,
  organizations: [],
};
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => ({ user: mockUser, refetchMe: vi.fn() }),
}));

import AccountPage from "./page";

describe("AccountPage", () => {
  beforeEach(() => {
    setPassword.mockClear();
  });

  it("omits the current-password field for a Google-only user", () => {
    mockUser = { ...mockUser, hasPassword: false, googleLinked: true };
    render(<AccountPage />);
    expect(screen.queryByLabelText(/current password/i)).toBeNull();
    expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /set password/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /manage agent connections/i })).toHaveAttribute(
      "href",
      "/account/agent-connections",
    );
  });

  it("asks for the current password once one is set", () => {
    mockUser = { ...mockUser, hasPassword: true, googleLinked: true };
    render(<AccountPage />);
    expect(screen.getByLabelText(/current password/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /change password/i })).toBeInTheDocument();
  });

  it("sends currentPassword: null for a Google-only user on submit", async () => {
    mockUser = { ...mockUser, hasPassword: false, googleLinked: true };
    render(<AccountPage />);

    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: "newSecret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /set password/i }));

    await waitFor(() => {
      expect(setPassword).toHaveBeenCalledWith({
        variables: { newPassword: "newSecret123", currentPassword: null },
      });
    });
  });

  it("sends the typed current password once the user already has one", async () => {
    mockUser = { ...mockUser, hasPassword: true, googleLinked: true };
    render(<AccountPage />);

    fireEvent.change(screen.getByLabelText(/current password/i), {
      target: { value: "oldSecret123" },
    });
    fireEvent.change(screen.getByLabelText(/new password/i), {
      target: { value: "newSecret123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /change password/i }));

    await waitFor(() => {
      expect(setPassword).toHaveBeenCalledWith({
        variables: { newPassword: "newSecret123", currentPassword: "oldSecret123" },
      });
    });
  });
});
