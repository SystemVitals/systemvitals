import type { Gql } from "./gql.js";
import { tools, type ToolDef } from "./tools.js";

export type Credential = {
  authKind: "session" | "api-token";
  credentialMode: "SESSION" | "LEGACY_BROAD" | "PROJECT_SCOPED";
  capabilities: readonly string[];
  organizationId: string | null;
  organizationName: string | null;
  projectId: string | null;
  projectName: string | null;
};

interface ApiCredentialResponse {
  apiCredential: Credential;
}

const READ_TOOLS = ["list_checks", "get_check"] as const;
const WRITE_TOOLS = [
  "create_heartbeat_check",
  "create_active_check",
  "update_check",
  "pause_check",
  "resume_check",
  "delete_check",
  "set_check_channel_enabled",
] as const;

export async function fetchCredential(gql: Gql): Promise<Credential> {
  const data = await gql(`query ApiCredential {
    apiCredential {
      authKind
      credentialMode
      capabilities
      organizationId
      organizationName
      projectId
      projectName
    }
  }`);
  return (data as unknown as ApiCredentialResponse).apiCredential;
}

export function toolsForCredential(
  credential: Credential,
): readonly ToolDef[] {
  if (
    credential.credentialMode === "SESSION" ||
    credential.credentialMode === "LEGACY_BROAD"
  ) {
    return tools;
  }

  const workspaceSelector =
    credential.organizationId !== null
      ? { organizationId: credential.organizationId }
      : credential.projectId !== null
        ? { projectId: credential.projectId }
        : null;

  if (workspaceSelector === null) {
    throw new Error(
      "Scoped API credential reports check capabilities but has no organization workspace ID.",
    );
  }

  const names = new Set<string>();
  if (credential.capabilities.includes("checks:read")) {
    for (const name of READ_TOOLS) names.add(name);
  }
  if (credential.capabilities.includes("checks:write")) {
    for (const name of WRITE_TOOLS) names.add(name);
  }

  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return [...names].map((name) => {
    const definition = byName.get(name);
    if (!definition) throw new Error(`MCP tool definition missing: ${name}`);
    const {
      organizationId: _organizationId,
      projectId: _projectId,
      ...inputSchema
    } = definition.inputSchema;
    return {
      ...definition,
      inputSchema,
      handler: (args, gql) => {
        const {
          organizationId: _callerOrganizationId,
          projectId: _callerProjectId,
          ...resourceArgs
        } = args;
        return definition.handler(
          { ...resourceArgs, ...workspaceSelector },
          gql,
        );
      },
    };
  });
}
