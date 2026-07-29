export type AgentClient =
  | "claude-code"
  | "codex"
  | "cursor"
  | "universal"
  | "graphql";

export interface AgentConnectionConfigInput {
  client: AgentClient;
  organizationId: string;
  organizationName: string;
  apiUrl: string;
  token: string;
}

type McpConfigInput = Omit<
  AgentConnectionConfigInput,
  "client" | "organizationId"
>;

const MCP_COMMAND = "npx";
const MCP_ARGS = ["-y", "@systemvitals/mcp"] as const;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function tomlString(value: string): string {
  let escaped = '"';

  for (const character of value) {
    switch (character) {
      case '"':
        escaped += '\\"';
        break;
      case "\\":
        escaped += "\\\\";
        break;
      case "\b":
        escaped += "\\b";
        break;
      case "\t":
        escaped += "\\t";
        break;
      case "\n":
        escaped += "\\n";
        break;
      case "\f":
        escaped += "\\f";
        break;
      case "\r":
        escaped += "\\r";
        break;
      default: {
        const codePoint = character.codePointAt(0);
        if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
          escaped += `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
        } else {
          escaped += character;
        }
      }
    }
  }

  return `${escaped}"`;
}

function assertShellSafe(value: string, field: string): void {
  const unsupported = value.match(/[\u0000-\u0008\u000B-\u001F\u007F]/u);
  if (!unsupported) {
    return;
  }

  const codePoint = unsupported[0].codePointAt(0);
  const code = codePoint?.toString(16).toUpperCase().padStart(4, "0") ?? "????";
  throw new Error(
    `Cannot generate shell configuration: ${field} contains unsupported control character U+${code}`,
  );
}

function mcpServer(input: McpConfigInput) {
  return {
    command: MCP_COMMAND,
    args: [...MCP_ARGS],
    env: {
      SYSTEMVITALS_API_URL: input.apiUrl,
      SYSTEMVITALS_API_TOKEN: input.token,
    },
  };
}

function generateClaudeCode(input: McpConfigInput): string {
  assertShellSafe(input.organizationName, "organizationName");
  assertShellSafe(input.apiUrl, "apiUrl");

  return [
    "read -rsp 'SystemVitals API token: ' SYSTEMVITALS_API_TOKEN",
    "printf '\\n'",
    [
    "claude mcp add",
    shellQuote(input.organizationName),
    "--env",
    shellQuote(`SYSTEMVITALS_API_URL=${input.apiUrl}`),
    "--env",
    '"SYSTEMVITALS_API_TOKEN=$SYSTEMVITALS_API_TOKEN"',
    "--",
    MCP_COMMAND,
    ...MCP_ARGS,
    ].join(" "),
    "unset SYSTEMVITALS_API_TOKEN",
  ].join("\n");
}

function generateCodex(input: McpConfigInput): string {
  return `[mcp_servers.${tomlString(input.organizationName)}]
command = ${tomlString(MCP_COMMAND)}
args = [${MCP_ARGS.map(tomlString).join(", ")}]
env = { SYSTEMVITALS_API_URL = ${tomlString(input.apiUrl)}, SYSTEMVITALS_API_TOKEN = ${tomlString(input.token)} }`;
}

function generateMcpJson(input: McpConfigInput): string {
  return JSON.stringify(
    {
      mcpServers: {
        [input.organizationName]: mcpServer(input),
      },
    },
    null,
    2,
  );
}

function generateCursor(input: McpConfigInput): string {
  return generateMcpJson(input);
}

function generateUniversal(input: McpConfigInput): string {
  return generateMcpJson(input);
}

function generateGraphql(
  input: Pick<
    AgentConnectionConfigInput,
    "apiUrl" | "token" | "organizationId"
  >,
): string {
  assertShellSafe(input.apiUrl, "apiUrl");
  assertShellSafe(input.organizationId, "organizationId");

  const body = JSON.stringify({
    query:
      'mutation CreateHeartbeat($organizationId: ID!) { createCheck(organizationId: $organizationId, name: "agent-heartbeat", periodSeconds: 300, graceSeconds: 60) { id } }',
    variables: { organizationId: input.organizationId },
  });

  return `read -rsp 'SystemVitals API token: ' SYSTEMVITALS_API_TOKEN
printf '\\n'
curl --request POST ${shellQuote(input.apiUrl)} \\
  --header "Authorization: Bearer $SYSTEMVITALS_API_TOKEN" \\
  --header 'Content-Type: application/json' \\
  --data-raw ${shellQuote(body)}
unset SYSTEMVITALS_API_TOKEN`;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported agent client: ${String(value)}`);
}

export function generateAgentConnectionConfig(
  input: AgentConnectionConfigInput,
): string {
  switch (input.client) {
    case "claude-code":
      return generateClaudeCode(input);
    case "codex":
      return generateCodex(input);
    case "cursor":
      return generateCursor(input);
    case "universal":
      return generateUniversal(input);
    case "graphql":
      return generateGraphql(input);
    default:
      return assertNever(input.client);
  }
}
