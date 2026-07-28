import { describe, expect, it, vi } from "vitest";
import type { Gql } from "../src/gql.js";
import {
  fetchCredential,
  toolsForCredential,
  type Credential,
} from "../src/credential.js";
import { tools } from "../src/tools.js";
import {
  EMAIL_VERIFICATION_TOOL_ALLOWLIST,
  emailVerificationLifecycleToolNames,
} from "./email-verification-tool-boundary.js";

const scopedCredential = (
  capabilities: readonly string[] = ["checks:read", "checks:write"],
): Credential => ({
  authKind: "api-token",
  credentialMode: "PROJECT_SCOPED",
  capabilities,
  projectId: "project-bound",
  projectName: "Production",
});

const SCOPED_TOOL_NAMES = [
  "list_checks",
  "get_check",
  "create_heartbeat_check",
  "create_active_check",
  "update_check",
  "pause_check",
  "resume_check",
  "delete_check",
  "set_check_channel_enabled",
];

describe("fetchCredential", () => {
  it("requests only public credential metadata", async () => {
    const gql = vi.fn<Gql>().mockResolvedValue({
      apiCredential: scopedCredential(),
    });

    await expect(fetchCredential(gql)).resolves.toEqual(scopedCredential());
    expect(gql).toHaveBeenCalledOnce();
    expect(gql.mock.calls[0]?.[0]).toContain("apiCredential");
    expect(gql.mock.calls[0]?.[0]).toContain("credentialMode");
    expect(gql.mock.calls[0]?.[0]).toContain("capabilities");
    expect(gql.mock.calls[0]?.[0]).not.toMatch(/token|secret/i);
  });
});

describe("toolsForCredential", () => {
  it("exposes reads and every checks:write mutation for a full scoped credential", () => {
    expect(toolsForCredential(scopedCredential()).map((tool) => tool.name)).toEqual(
      SCOPED_TOOL_NAMES,
    );
  });

  it("removes projectId from every scoped schema", () => {
    for (const tool of toolsForCredential(scopedCredential())) {
      expect(tool.inputSchema).not.toHaveProperty("projectId");
    }
  });

  it("injects the bound project and ignores a caller-supplied projectId", async () => {
    const listChecks = toolsForCredential(scopedCredential()).find(
      (tool) => tool.name === "list_checks",
    );
    const gql = vi.fn<Gql>().mockResolvedValue({ checks: [] });

    await listChecks?.handler({ projectId: "attacker-project" }, gql);

    expect(gql).toHaveBeenCalledWith(expect.any(String), {
      projectId: "project-bound",
    });
  });

  it("exposes only read tools for a read-only scoped credential", () => {
    expect(
      toolsForCredential(scopedCredential(["checks:read"])).map(
        (tool) => tool.name,
      ),
    ).toEqual(["list_checks", "get_check"]);
  });

  it("classifies notification routing as checks:write, never checks:read", () => {
    expect(
      toolsForCredential(scopedCredential(["checks:write"])).map(
        (tool) => tool.name,
      ),
    ).toContain("set_check_channel_enabled");
    expect(
      toolsForCredential(scopedCredential(["checks:read"])).map(
        (tool) => tool.name,
      ),
    ).not.toContain("set_check_channel_enabled");
  });

  it("exposes no tools when a scoped credential has no recognized capabilities", () => {
    expect(toolsForCredential(scopedCredential([]))).toEqual([]);
  });

  it("retains every tool, including notification routing, for sessions", () => {
    const selected = toolsForCredential({
      authKind: "session",
      credentialMode: "SESSION",
      capabilities: [],
      projectId: null,
      projectName: null,
    });

    expect(selected.map((tool) => tool.name)).toEqual(
      tools.map((tool) => tool.name),
    );
    expect(selected.map((tool) => tool.name)).toContain(
      "set_check_channel_enabled",
    );
    expect(
      emailVerificationLifecycleToolNames(selected.map((tool) => tool.name)),
    ).toEqual(EMAIL_VERIFICATION_TOOL_ALLOWLIST);
    expect(
      selected.find((tool) => tool.name === "list_checks")?.inputSchema,
    ).toHaveProperty("projectId");
  });

  it("retains every tool, including notification routing, for an unbound legacy broad API token", () => {
    const selected = toolsForCredential({
      authKind: "api-token",
      credentialMode: "LEGACY_BROAD",
      capabilities: ["checks:read", "checks:write"],
      projectId: null,
      projectName: null,
    });

    expect(selected.map((tool) => tool.name)).toContain(
      "set_check_channel_enabled",
    );
    expect(
      emailVerificationLifecycleToolNames(selected.map((tool) => tool.name)),
    ).toEqual(EMAIL_VERIFICATION_TOOL_ALLOWLIST);
  });

  it("fails closed for an unbound partial check credential", () => {
    expect(() =>
      toolsForCredential({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read"],
        projectId: null,
        projectName: null,
      }),
    ).toThrow(
      "Scoped API credential reports check capabilities but has no project ID.",
    );
  });

  it("fails closed for an unbound full explicit check credential", () => {
    expect(() =>
      toolsForCredential({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read", "checks:write"],
        projectId: null,
        projectName: null,
      }),
    ).toThrow(
      "Scoped API credential reports check capabilities but has no project ID.",
    );
  });
});
