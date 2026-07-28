/**
 * SystemVitals MCP server factory.
 *
 * `buildServer(gql)` wires every ToolDef from tools.ts into a McpServer
 * instance and returns the server plus the list of registered tool names.
 *
 * Keeping `gql` injectable means tests can pass a fake — no live API needed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Gql } from "./gql.js";
import { fetchCredential, toolsForCredential } from "./credential.js";

export type BuildServerResult = {
  server: McpServer;
  toolNames: string[];
} & PromiseLike<{ server: McpServer; toolNames: string[] }>;

/**
 * Create and configure the MCP server bound to the given Gql function.
 *
 * Returns both the configured McpServer and the list of tool names that were
 * registered, so callers (and tests) can verify registration without needing
 * to introspect SDK internals.
 */
export function buildServer(gql: Gql): BuildServerResult {
  const server = new McpServer({ name: "systemvitals", version: "0.1.0" });
  const toolNames: string[] = [];

  const initialization = fetchCredential(gql).then((credential) => {
    for (const def of toolsForCredential(credential)) {
      server.registerTool(
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
        (args: Record<string, unknown>) => def.handler(args, gql),
      );
      toolNames.push(def.name);
    }
    return { server, toolNames };
  });

  const originalConnect = server.connect.bind(server);
  server.connect = async (transport) => {
    await initialization;
    return originalConnect(transport);
  };

  return {
    server,
    toolNames,
    then: (onfulfilled, onrejected) =>
      initialization.then(onfulfilled, onrejected),
  };
}
