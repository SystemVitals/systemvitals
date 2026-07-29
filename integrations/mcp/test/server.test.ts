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

const SESSION_TOOL_NAMES = [
  "create_active_check",
  "create_channel",
  "create_heartbeat_check",
  "create_organization",
  "delete_channel",
  "delete_check",
  "delete_organization",
  "get_check",
  "invite_member",
  "leave_organization",
  "list_channels",
  "list_checks",
  "list_members",
  "list_projects",
  "pause_check",
  "regenerate_ping_key",
  "remove_member",
  "resend_email_channel_verification",
  "resume_check",
  "revoke_invite",
  "set_check_channel_enabled",
  "transfer_organization_creatorship",
  "update_check",
  "update_member_role",
  "update_organization",
] as const;

const SCOPED_CHECK_TOOL_NAMES = [
  "create_active_check",
  "create_heartbeat_check",
  "delete_check",
  "get_check",
  "list_checks",
  "pause_check",
  "resume_check",
  "set_check_channel_enabled",
  "update_check",
] as const;

describe("buildServer", () => {
  it("fetches the credential once and registers every tool for a session", async () => {
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
    expect([...toolNames].sort()).toEqual(SESSION_TOOL_NAMES);
    expect(emailVerificationLifecycleToolNames(toolNames)).toEqual(
      EMAIL_VERIFICATION_TOOL_ALLOWLIST,
    );
  });

  it("registers the full catalog, including email verification resend, for a legacy broad token", async () => {
    const { toolNames } = await buildServer(
      credentialGql({
        authKind: "api-token",
        credentialMode: "LEGACY_BROAD",
        capabilities: ["checks:read", "checks:write"],
        projectId: null,
        projectName: null,
      }),
    );

    expect(toolNames).toHaveLength(25);
    expect([...toolNames].sort()).toEqual(SESSION_TOOL_NAMES);
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

  it("registers exactly the nine check tools for a full scoped credential", async () => {
    const { toolNames } = await buildServer(
      credentialGql({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read", "checks:write"],
        projectId: "project-1",
        projectName: "Production",
      }),
    );

    expect(toolNames).toHaveLength(9);
    expect([...toolNames].sort()).toEqual(SCOPED_CHECK_TOOL_NAMES);
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
