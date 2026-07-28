#!/usr/bin/env node
/**
 * SystemVitals MCP server entry point.
 *
 * Reads SYSTEMVITALS_API_URL and SYSTEMVITALS_API_TOKEN from the environment,
 * builds the MCP server, and connects a stdio transport.
 *
 * Usage:
 *   SYSTEMVITALS_API_URL=http://localhost:8888/graphql \
 *   SYSTEMVITALS_API_TOKEN=svt_xxx \
 *   npx tsx cli/mcp.ts
 *
 * Or via npm start (same env vars required).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeGql } from "../src/gql.js";
import { buildServer } from "../src/server.js";

const apiUrl = process.env["SYSTEMVITALS_API_URL"];
const apiToken = process.env["SYSTEMVITALS_API_TOKEN"];

if (!apiUrl) {
  console.error(
    "Error: SYSTEMVITALS_API_URL is not set.\n" +
      "Set it to your SystemVitals GraphQL endpoint, e.g.:\n" +
      "  export SYSTEMVITALS_API_URL=http://localhost:8888/graphql",
  );
  process.exit(1);
}

if (!apiToken) {
  console.error(
    "Error: SYSTEMVITALS_API_TOKEN is not set.\n" +
      "Generate an API token in the SystemVitals dashboard and set:\n" +
      "  export SYSTEMVITALS_API_TOKEN=svt_xxx",
  );
  process.exit(1);
}

const gql = makeGql(apiUrl, apiToken);
const { server } = buildServer(gql);

const transport = new StdioServerTransport();
await server.connect(transport);
