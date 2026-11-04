import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState, useEffect, useRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApolloClient, ApolloLink, InMemoryCache, gql } from "@apollo/client";
import { ApolloProvider } from "@apollo/client/react";
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

function SessionProbe() {
  const { user, login, logout } = useAuth();
  return (
    <div>
      <p>{user ? user.email : "anon"}</p>
      <button onClick={() => void login("b@y.com", "secret")}>log in</button>
      <button onClick={logout}>log out</button>
    </div>
  );
}

const CACHED = gql`
  query cached {
    accountOverview {
      organizationCount
    }
  }
`;

/** A client whose cache already holds another session's data. */
function clientWithCachedData() {
  const client = new ApolloClient({ cache: new InMemoryCache(), link: ApolloLink.empty() });
  client.writeQuery({
    query: CACHED,
    data: { accountOverview: { __typename: "AccountOverview", organizationCount: 4 } },
  });
  return client;
}

function meResponse(email: string) {
  return {
    ok: true,
    json: async () => ({
      data: { me: { id: "1", email, isAdmin: false, hasPassword: true, googleLinked: false, organizations: [] } },
    }),
  };
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

  describe("Apollo store", () => {
    it("is cleared on logout so the next account never sees cached data", async () => {
      localStorage.setItem("sv_token", "user-a");
      vi.stubGlobal("fetch", vi.fn(async () => meResponse("a@y.com")) as unknown as typeof fetch);
      const client = clientWithCachedData();
      render(
        <ApolloProvider client={client}>
          <AuthProvider><SessionProbe /></AuthProvider>
        </ApolloProvider>,
      );
      await screen.findByText("a@y.com");
      expect(client.readQuery({ query: CACHED })).not.toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "log out" }));

      await waitFor(() => expect(client.readQuery({ query: CACHED })).toBeNull());
      expect(screen.getByText("anon")).toBeInTheDocument();
    });

    it("is cleared on login", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) =>
        String(url).endsWith("/auth/login")
          ? { ok: true, json: async () => ({ token: "user-b" }) }
          : meResponse("b@y.com"),
      ) as unknown as typeof fetch);
      const client = clientWithCachedData();
      render(
        <ApolloProvider client={client}>
          <AuthProvider><SessionProbe /></AuthProvider>
        </ApolloProvider>,
      );
      await screen.findByText("anon");

      fireEvent.click(screen.getByRole("button", { name: "log in" }));

      await screen.findByText("b@y.com");
      expect(client.readQuery({ query: CACHED })).toBeNull();
    });

    it("is cleared when signing in with a token", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => meResponse("google@y.com")) as unknown as typeof fetch);
      const client = clientWithCachedData();
      render(
        <ApolloProvider client={client}>
          <AuthProvider><LoginWithTokenProbe token="good.jwt.token" /></AuthProvider>
        </ApolloProvider>,
      );

      await screen.findByText("google@y.com");
      expect(client.readQuery({ query: CACHED })).toBeNull();
    });

    it("is optional: logging out without an Apollo provider still works", async () => {
      localStorage.setItem("sv_token", "user-a");
      vi.stubGlobal("fetch", vi.fn(async () => meResponse("a@y.com")) as unknown as typeof fetch);
      render(<AuthProvider><SessionProbe /></AuthProvider>);
      await screen.findByText("a@y.com");

      fireEvent.click(screen.getByRole("button", { name: "log out" }));

      expect(await screen.findByText("anon")).toBeInTheDocument();
      expect(localStorage.getItem("sv_token")).toBeNull();
    });
  });
});
