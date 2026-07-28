import { describe, it, expect } from "vitest";
import type { Gql } from "../src/gql.js";
import { buildServer } from "../src/server.js";
import {
  EMAIL_VERIFICATION_TOOL_ALLOWLIST,
  emailVerificationLifecycleToolNames,
} from "./email-verification-tool-boundary.js";

// ---------------------------------------------------------------------------
// Minimal fake gql — not called by buildServer itself, but required to
// construct the server (the gql is injected into each tool's handler closure).
// ---------------------------------------------------------------------------
function credentialGql(credential: Record<string, unknown>): Gql {
  return async () => ({ apiCredential: credential });
}

describe("buildServer", () => {
  it("fetches the credential once and registers all 25 tools including email verification resend for a session", async () => {
    let calls = 0;
    const gql: Gql = async () => {
      calls += 1;
      return {
        apiCredential: {
          authKind: "session",
          credentialMode: "SESSION",
          capabilities: [],
          projectId: null,
          projectName: null,
        },
      };
    };
    const { toolNames } = await buildServer(gql);

    expect(calls).toBe(1);
    expect(toolNames).toHaveLength(25);
    expect(emailVerificationLifecycleToolNames(toolNames)).toEqual(
      EMAIL_VERIFICATION_TOOL_ALLOWLIST,
    );
  });

  it("registers only email verification resend for a legacy broad token", async () => {
    const { toolNames } = await buildServer(
      credentialGql({
        authKind: "api-token",
        credentialMode: "LEGACY_BROAD",
        capabilities: ["checks:read", "checks:write"],
        projectId: null,
        projectName: null,
      }),
    );

    expect(emailVerificationLifecycleToolNames(toolNames)).toEqual(
      EMAIL_VERIFICATION_TOOL_ALLOWLIST,
    );
  });

  it("registers exactly the scoped read tools for a read-only token", async () => {
    const { toolNames } = await buildServer(
      credentialGql({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read"],
        projectId: "project-1",
        projectName: "Production",
      }),
    );

    expect(toolNames).toEqual(["list_checks", "get_check"]);
  });

  it("registers every selected ToolDef exactly once", async () => {
    const { toolNames } = await buildServer(
      credentialGql({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read", "checks:write"],
        projectId: "project-1",
        projectName: "Production",
      }),
    );
    const unique = new Set(toolNames);
    expect(unique.size).toBe(toolNames.length);
  });

  it("fails startup clearly for an unbound full explicit scoped credential", async () => {
    await expect(
      buildServer(
        credentialGql({
          authKind: "api-token",
          credentialMode: "PROJECT_SCOPED",
          capabilities: ["checks:read", "checks:write"],
          projectId: null,
          projectName: null,
        }),
      ),
    ).rejects.toThrow(
      "Scoped API credential reports check capabilities but has no project ID.",
    );
  });
});
