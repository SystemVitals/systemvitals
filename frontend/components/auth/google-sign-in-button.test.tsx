import { render, screen } from "@testing-library/react";
import { describe, it, expect, afterEach, vi } from "vitest";

describe("GoogleSignInButton", () => {
  const originalEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED;

  afterEach(() => {
    process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED = originalEnabled;
  });

  it('renders the "Continue with Google" link when the flag is "true"', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED = "true";
    const { GoogleSignInButton } = await import("./google-sign-in-button");

    render(<GoogleSignInButton />);

    expect(
      screen.getByRole("link", { name: /continue with google/i })
    ).toBeInTheDocument();
  });

  it("renders nothing when the flag is unset", async () => {
    vi.resetModules();
    delete process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED;
    const { GoogleSignInButton } = await import("./google-sign-in-button");

    const { container } = render(<GoogleSignInButton />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the flag is any value other than "true"', async () => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED = "false";
    const { GoogleSignInButton } = await import("./google-sign-in-button");

    const { container } = render(<GoogleSignInButton />);

    expect(container).toBeEmptyDOMElement();
  });
});
