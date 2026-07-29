import { describe, expect, it, vi } from "vitest";
import type { Gql } from "../src/gql.js";
import {
  fetchCredential,
  toolsForCredential,
  type Credential,
} from "../src/credential.js";
import { normalizeGqlError } from "../src/gql.js";
import { tools } from "../src/tools.js";
import {
  EMAIL_VERIFICATION_TOOL_ALLOWLIST,
  LEGACY_PROJECT_TOOL_ALLOWLIST,
  emailVerificationLifecycleToolNames,
  legacyProjectToolNames,
} from "./email-verification-tool-boundary.js";

const scopedCredential = (
  capabilities: readonly string[] = ["checks:read", "checks:write"],
): Credential => ({
  authKind: "api-token",
  credentialMode: "PROJECT_SCOPED",
  capabilities,
  organizationId: "organization-bound",
  organizationName: "Acme",
  projectId: "project-bound",
  projectName: "Production",
});

const legacyScopedCredential = (): Credential => ({
  ...scopedCredential(),
  organizationId: null,
  organizationName: null,
});

const legacyApiCredentialResponse = () => ({
  authKind: "api-token",
  credentialMode: "PROJECT_SCOPED",
  capabilities: ["checks:read", "checks:write"],
  projectId: "project-bound",
  projectName: "Production",
});

function makeGqlStyleError(message: string): Error {
  return normalizeGqlError(new Error(message));
}

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

const ALL_TOOL_NAMES = [
  "list_organizations",
  "list_projects",
  "list_checks",
  "get_check",
  "list_channels",
  "create_heartbeat_check",
  "create_active_check",
  "pause_check",
  "resume_check",
  "delete_check",
  "set_check_channel_enabled",
  "create_channel",
  "resend_email_channel_verification",
  "delete_channel",
  "regenerate_ping_key",
  "update_check",
  "list_members",
  "invite_member",
  "revoke_invite",
  "update_member_role",
  "remove_member",
  "create_organization",
  "update_organization",
  "transfer_organization_creatorship",
  "leave_organization",
  "delete_organization",
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
    expect(gql.mock.calls[0]?.[0]).toContain("organizationId");
    expect(gql.mock.calls[0]?.[0]).toContain("organizationName");
    expect(gql.mock.calls[0]?.[0]).not.toMatch(/token|secret/i);
  });

  it.each([
    'Cannot query field "organizationId" on type "ApiCredential". Did you mean "projectId"?',
    'Cannot query field "organizationName" on type "ApiCredential". Did you mean "projectName"?',
    'Cannot query field "organizationId" on type "ApiCredential".\nCannot query field "organizationName" on type "ApiCredential".',
  ])(
    "retries one legacy metadata query when an older API rejects organization fields: %s",
    async (message) => {
      const gql = vi
        .fn<Gql>()
        .mockRejectedValueOnce(makeGqlStyleError(message))
        .mockResolvedValueOnce({
          apiCredential: legacyApiCredentialResponse(),
        });

      await expect(fetchCredential(gql)).resolves.toEqual(
        legacyScopedCredential(),
      );
      expect(gql).toHaveBeenCalledTimes(2);

      const canonicalQuery = gql.mock.calls[0]?.[0] ?? "";
      expect(canonicalQuery).toContain("organizationId");
      expect(canonicalQuery).toContain("organizationName");

      const legacyQuery = gql.mock.calls[1]?.[0] ?? "";
      expect(legacyQuery).toContain("authKind");
      expect(legacyQuery).toContain("credentialMode");
      expect(legacyQuery).toContain("capabilities");
      expect(legacyQuery).toContain("projectId");
      expect(legacyQuery).toContain("projectName");
      expect(legacyQuery).not.toMatch(/organizationId|organizationName/);
      expect(legacyQuery).not.toMatch(/token|secret/i);
    },
  );

  it("returns legacy scoped tools that hide selectors and inject the bound project", async () => {
    const discoveryGql = vi
      .fn<Gql>()
      .mockRejectedValueOnce(
        makeGqlStyleError(
          'Cannot query field "organizationId" on type "ApiCredential".',
        ),
      )
      .mockResolvedValueOnce({
        apiCredential: legacyApiCredentialResponse(),
      });

    const credential = await fetchCredential(discoveryGql);
    const selected = toolsForCredential(credential);
    for (const tool of selected) {
      expect(tool.inputSchema).not.toHaveProperty("organizationId");
      expect(tool.inputSchema).not.toHaveProperty("projectId");
    }

    const listChecks = selected.find((tool) => tool.name === "list_checks");
    const toolGql = vi.fn<Gql>().mockResolvedValue({ checks: [] });
    await listChecks?.handler(
      {
        organizationId: "attacker-organization",
        projectId: "attacker-project",
      },
      toolGql,
    );
    expect(toolGql).toHaveBeenCalledWith(expect.any(String), {
      projectId: "project-bound",
    });
  });

  it.each([
    ["authentication", "Unauthorized"],
    ["authorization", "Forbidden"],
    [
      "transport",
      "GraphQL request failed: HTTP 503 Service Unavailable",
    ],
    ["arbitrary GraphQL", "Resolver exploded"],
    [
      "unrelated credential field",
      'Cannot query field "projectId" on type "ApiCredential".',
    ],
    [
      "organization field on another type",
      'Cannot query field "organizationId" on type "Query".',
    ],
  ])("does not retry a %s error", async (_case, rawMessage) => {
    const error = makeGqlStyleError(rawMessage);
    const gql = vi.fn<Gql>().mockRejectedValue(error);

    await expect(fetchCredential(gql)).rejects.toThrow(error.message);
    expect(gql).toHaveBeenCalledOnce();
  });

  it("does not retry or leak secrets from an arbitrary GraphQL error", async () => {
    const gql = vi
      .fn<Gql>()
      .mockRejectedValue(
        makeGqlStyleError("Resolver exploded with svt_do-not-leak"),
      );

    const error = await fetchCredential(gql).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("[redacted]");
    expect((error as Error).message).not.toContain("svt_do-not-leak");
    expect(gql).toHaveBeenCalledOnce();
  });
});

describe("toolsForCredential", () => {
  it("exposes reads and every checks:write mutation for a full scoped credential", () => {
    const selectedNames = toolsForCredential(scopedCredential()).map(
      (tool) => tool.name,
    );

    expect(selectedNames).toHaveLength(9);
    expect(selectedNames).toEqual(SCOPED_TOOL_NAMES);
  });

  it("removes both workspace selectors from every scoped schema", () => {
    for (const tool of toolsForCredential(scopedCredential())) {
      expect(tool.inputSchema).not.toHaveProperty("organizationId");
      expect(tool.inputSchema).not.toHaveProperty("projectId");
    }
  });

  it("injects the bound organization and ignores caller-supplied selectors", async () => {
    const listChecks = toolsForCredential(scopedCredential()).find(
      (tool) => tool.name === "list_checks",
    );
    const gql = vi.fn<Gql>().mockResolvedValue({ checks: [] });

    await listChecks?.handler(
      {
        organizationId: "attacker-organization",
        projectId: "attacker-project",
      },
      gql,
    );

    expect(gql).toHaveBeenCalledWith(expect.any(String), {
      organizationId: "organization-bound",
    });
  });

  it("falls back to the bound project returned by an older API", async () => {
    const credential = {
      ...scopedCredential(),
      organizationId: null,
      organizationName: null,
    };
    const listChecks = toolsForCredential(credential).find(
      (tool) => tool.name === "list_checks",
    );
    const gql = vi.fn<Gql>().mockResolvedValue({ checks: [] });

    await listChecks?.handler(
      {
        organizationId: "attacker-organization",
        projectId: "attacker-project",
      },
      gql,
    );

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
      organizationId: null,
      organizationName: null,
      projectId: null,
      projectName: null,
    });

    expect(tools.map((tool) => tool.name)).toEqual(ALL_TOOL_NAMES);
    expect(selected).toHaveLength(26);
    expect(selected.map((tool) => tool.name)).toEqual(ALL_TOOL_NAMES);
    expect(
      emailVerificationLifecycleToolNames(selected.map((tool) => tool.name)),
    ).toEqual(EMAIL_VERIFICATION_TOOL_ALLOWLIST);
    expect(legacyProjectToolNames(selected.map((tool) => tool.name))).toEqual(
      LEGACY_PROJECT_TOOL_ALLOWLIST,
    );
    expect(
      selected.find((tool) => tool.name === "list_checks")?.inputSchema,
    ).toHaveProperty("organizationId");
    expect(
      selected.find((tool) => tool.name === "list_checks")?.inputSchema,
    ).toHaveProperty("projectId");
  });

  it("retains every tool, including notification routing, for an unbound legacy broad API token", () => {
    const selected = toolsForCredential({
      authKind: "api-token",
      credentialMode: "LEGACY_BROAD",
      capabilities: ["checks:read", "checks:write"],
      organizationId: null,
      organizationName: null,
      projectId: null,
      projectName: null,
    });

    expect(selected).toHaveLength(26);
    expect(selected.map((tool) => tool.name)).toEqual(ALL_TOOL_NAMES);
    expect(
      emailVerificationLifecycleToolNames(selected.map((tool) => tool.name)),
    ).toEqual(EMAIL_VERIFICATION_TOOL_ALLOWLIST);
    expect(legacyProjectToolNames(selected.map((tool) => tool.name))).toEqual(
      LEGACY_PROJECT_TOOL_ALLOWLIST,
    );
  });

  it("fails closed for an unbound partial check credential", () => {
    expect(() =>
      toolsForCredential({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read"],
        organizationId: null,
        organizationName: null,
        projectId: null,
        projectName: null,
      }),
    ).toThrow(
      "Scoped API credential reports check capabilities but has no organization workspace ID.",
    );
  });

  it("fails closed for an unbound full explicit check credential", () => {
    expect(() =>
      toolsForCredential({
        authKind: "api-token",
        credentialMode: "PROJECT_SCOPED",
        capabilities: ["checks:read", "checks:write"],
        organizationId: null,
        organizationName: null,
        projectId: null,
        projectName: null,
      }),
    ).toThrow(
      "Scoped API credential reports check capabilities but has no organization workspace ID.",
    );
  });
});
