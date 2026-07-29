import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, useEffect, useRef } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, useAuth } from "@/lib/auth-context";

function Probe() {
  const { user, loading } = useAuth();
  return <div>{loading ? "loading" : user ? user.email : "anon"}</div>;
}

function LoginWithTokenProbe({ token }: { token: string }) {
  const { user, loginWithToken } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    loginWithToken(token).catch((e: unknown) => setError(e instanceof Error ? e.message : "error"));
  }, [token, loginWithToken]);

  return <div>{error ? `error:${error}` : user ? user.email : "pending"}</div>;
}

describe("AuthProvider", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("renders anon when there is no token", async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("anon")).toBeInTheDocument());
  });

  it("loads the user when a token is present", async () => {
    localStorage.setItem("sv_token", "fake");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { me: { id: "1", email: "x@y.com", isAdmin: false, hasPassword: false, googleLinked: false, organizations: [] } } }),
    })) as unknown as typeof fetch);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText("x@y.com")).toBeInTheDocument());
    const request = vi.mocked(fetch).mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as { query: string };
    expect(body.query).toContain("creatorUserId");
    expect(body.query).toContain("creatorLabel");
    expect(body.query).toMatch(/organizations\s*\{[\s\S]*?pingKey/);
    expect(body.query).not.toContain("projects");
  });

  it("loginWithToken validates the token against /graphql, THEN persists it and sets the user", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: { me: { id: "1", email: "google@y.com", isAdmin: false, hasPassword: false, googleLinked: true, organizations: [] } },
      }),
    })) as unknown as typeof fetch);

    render(<AuthProvider><LoginWithTokenProbe token="good.jwt.token" /></AuthProvider>);

    await waitFor(() => expect(screen.getByText("google@y.com")).toBeInTheDocument());
    // The security property under test: the token is only written to localStorage
    // AFTER `me` resolved to a real user — never speculatively, never up-front.
    expect(localStorage.getItem("sv_token")).toBe("good.jwt.token");
    // loginWithToken must be invoked exactly once despite AuthProvider recreating it on every render.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("loginWithToken does NOT persist a token the API rejects (me came back null)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { me: null } }),
    })) as unknown as typeof fetch);

    render(<AuthProvider><LoginWithTokenProbe token="stale.jwt.token" /></AuthProvider>);

    await waitFor(() => expect(screen.getByText(/^error:/)).toBeInTheDocument());
    // The failure path must leave localStorage untouched, not merely surface an error.
    expect(localStorage.getItem("sv_token")).toBeNull();
  });
});
