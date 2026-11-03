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
 * Sent to MCP clients at initialization so agents look up a check's own
 * runbook before they audit or try to fix it.
 */
export const SERVER_INSTRUCTIONS =
  "SystemVitals monitors heartbeat and HTTP/TCP checks. Before you audit, debug or fix a check, call get_check: its description holds the human fix steps and its agent instructions (when set) say what to inspect, which fixes are safe to apply and when to stop and ask a human. Follow the agent instructions over generic guesses. Use update_check to keep both fields accurate after you learn something new about a check.";

/**
 * Create and configure the MCP server bound to the given Gql function.
 *
 * Returns both the configured McpServer and the list of tool names that were
 * registered, so callers (and tests) can verify registration without needing
 * to introspect SDK internals.
 */
export function buildServer(gql: Gql): BuildServerResult {
  const server = new McpServer(
    { name: "systemvitals", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );
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
