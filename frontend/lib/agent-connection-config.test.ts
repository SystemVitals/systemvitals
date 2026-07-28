import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  generateAgentConnectionConfig,
  type AgentClient,
} from "./agent-connection-config";

const input = {
  connectionName: "Production checks",
  apiUrl: "https://api.systemvitals.example/graphql",
  token: "svt_secret",
  projectId: "project_123",
};

describe("generateAgentConnectionConfig", () => {
  it.each<[AgentClient, string]>([
    [
      "claude-code",
      `read -rsp 'SystemVitals API token: ' SYSTEMVITALS_API_TOKEN
printf '\\n'
claude mcp add 'Production checks' --env 'SYSTEMVITALS_API_URL=https://api.systemvitals.example/graphql' --env "SYSTEMVITALS_API_TOKEN=$SYSTEMVITALS_API_TOKEN" -- npx -y @systemvitals/mcp
unset SYSTEMVITALS_API_TOKEN`,
    ],
    [
      "codex",
      `[mcp_servers."Production checks"]
command = "npx"
args = ["-y", "@systemvitals/mcp"]
env = { SYSTEMVITALS_API_URL = "https://api.systemvitals.example/graphql", SYSTEMVITALS_API_TOKEN = "svt_secret" }`,
    ],
    [
      "cursor",
      `{
  "mcpServers": {
    "Production checks": {
      "command": "npx",
      "args": [
        "-y",
        "@systemvitals/mcp"
      ],
      "env": {
        "SYSTEMVITALS_API_URL": "https://api.systemvitals.example/graphql",
        "SYSTEMVITALS_API_TOKEN": "svt_secret"
      }
    }
  }
}`,
    ],
    [
      "universal",
      `{
  "mcpServers": {
    "Production checks": {
      "command": "npx",
      "args": [
        "-y",
        "@systemvitals/mcp"
      ],
      "env": {
        "SYSTEMVITALS_API_URL": "https://api.systemvitals.example/graphql",
        "SYSTEMVITALS_API_TOKEN": "svt_secret"
      }
    }
  }
}`,
    ],
    [
      "graphql",
      `read -rsp 'SystemVitals API token: ' SYSTEMVITALS_API_TOKEN
printf '\\n'
curl --request POST 'https://api.systemvitals.example/graphql' \\
  --header "Authorization: Bearer $SYSTEMVITALS_API_TOKEN" \\
  --header 'Content-Type: application/json' \\
  --data-raw '{"query":"mutation CreateHeartbeat($projectId: ID!) { createCheck(projectId: $projectId, name: \\"agent-heartbeat\\", periodSeconds: 300, graceSeconds: 60) { id } }","variables":{"projectId":"project_123"}}'
unset SYSTEMVITALS_API_TOKEN`,
    ],
  ])("generates the exact %s output", (client, expected) => {
    const result = generateAgentConnectionConfig({ client, ...input });
    expect(result).toBe(expected);
    if (client === "claude-code" || client === "graphql") {
      expect(result).not.toContain(input.token);
    }
  });

  it.each(["cursor", "universal"] as const)(
    "produces parseable %s JSON with adversarial values intact",
    (client) => {
      const adversarial = {
        client,
        connectionName: 'name "quoted"\nnext',
        apiUrl: "https://example.test/g?q=\"yes\"\nline",
        token: "svt_'\" $() `touch nope`\nsecret",
        projectId: "project ignored by MCP config",
      };

      const parsed = JSON.parse(generateAgentConnectionConfig(adversarial));

      expect(parsed).toEqual({
        mcpServers: {
          [adversarial.connectionName]: {
            command: "npx",
            args: ["-y", "@systemvitals/mcp"],
            env: {
              SYSTEMVITALS_API_URL: adversarial.apiUrl,
              SYSTEMVITALS_API_TOKEN: adversarial.token,
            },
          },
        },
      });
    },
  );

  it("escapes Codex TOML strings and quoted table keys", () => {
    const result = generateAgentConnectionConfig({
      client: "codex",
      connectionName: 'prod"]\n[mcp_servers.injected',
      apiUrl: 'https://example.test/"quoted"\nline',
      token: 'svt_"quoted"\\backslash\nnext',
      projectId: "unused",
    });

    expect(result).toBe(`[mcp_servers."prod\\"]\\n[mcp_servers.injected"]
command = "npx"
args = ["-y", "@systemvitals/mcp"]
env = { SYSTEMVITALS_API_URL = "https://example.test/\\"quoted\\"\\nline", SYSTEMVITALS_API_TOKEN = "svt_\\"quoted\\"\\\\backslash\\nnext" }`);
    expect(result).not.toContain("\n[mcp_servers.injected]");

    const parsed = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))",
        ],
        { input: result, encoding: "utf8" },
      ),
    );
    expect(parsed.mcp_servers['prod"]\n[mcp_servers.injected']).toEqual({
      command: "npx",
      args: ["-y", "@systemvitals/mcp"],
      env: {
        SYSTEMVITALS_API_URL: 'https://example.test/"quoted"\nline',
        SYSTEMVITALS_API_TOKEN: 'svt_"quoted"\\backslash\nnext',
      },
    });
  });

  it("TOML-escapes disallowed controls and round-trips their values", () => {
    const controls = "\0\r\u001b\u007f";
    const result = generateAgentConnectionConfig({
      client: "codex",
      connectionName: `name${controls}`,
      apiUrl: `https://example.test/${controls}`,
      token: `svt_${controls}`,
      projectId: "unused",
    });

    expect(result).toContain(
      '"name\\u0000\\r\\u001B\\u007F"',
    );
    expect(result).not.toContain("\0");
    expect(result).not.toContain("\u001b");
    expect(result).not.toContain("\u007f");

    const parsed = JSON.parse(
      execFileSync(
        "python3",
        [
          "-c",
          "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read())))",
        ],
        { input: result, encoding: "utf8" },
      ),
    );
    expect(parsed.mcp_servers[`name${controls}`]).toEqual({
      command: "npx",
      args: ["-y", "@systemvitals/mcp"],
      env: {
        SYSTEMVITALS_API_URL: `https://example.test/${controls}`,
        SYSTEMVITALS_API_TOKEN: `svt_${controls}`,
      },
    });
  });

  it.each([
    ["NUL", "\0"],
    ["CR", "\r"],
    ["ESC", "\u001b"],
    ["DEL", "\u007f"],
  ])("does not interpolate a token containing %s into shell output", (_name, control) => {
    const secret = `svt_private${control}do-not-print`;

    for (const client of ["claude-code", "graphql"] as const) {
      const result = generateAgentConnectionConfig({
        client,
        connectionName: "Production checks",
        apiUrl: "https://example.test/graphql",
        token: secret,
        projectId: "project_123",
      });
      expect(result).not.toContain("svt_private");
      expect(result).not.toContain("do-not-print");
    }
  });

  it.each(["claude-code", "graphql"] as const)(
    "shell-quotes every %s user value as one inert argument",
    (client) => {
      const adversarial = {
        client,
        connectionName: "agent'; touch /tmp/systemvitals-injected; echo '",
        apiUrl: "https://example.test/' $(touch /tmp/systemvitals-injected)\nnext",
        token: "svt_'\"; touch /tmp/systemvitals-injected; # secret",
        projectId: "project_' $(touch /tmp/systemvitals-injected)\nnext",
      };
      const command = generateAgentConnectionConfig(adversarial);

      expect(() =>
        execFileSync("bash", ["-n"], { input: command, stdio: ["pipe", "pipe", "pipe"] }),
      ).not.toThrow();

      if (client === "claude-code") {
        const output = execFileSync(
          "bash",
          [
            "-c",
            `claude() { printf '%s\\0' "$@"; }
${command}
printf 'token-after=%s' "\${SYSTEMVITALS_API_TOKEN-unset}"`,
          ],
          { encoding: "utf8", input: `${adversarial.token}\n` },
        );
        const [argumentsOutput, tokenAfter] = output.split("token-after=");
        expect(argumentsOutput.replace(/^\n/, "").split("\0").slice(0, -1)).toEqual([
          "mcp",
          "add",
          adversarial.connectionName,
          "--env",
          `SYSTEMVITALS_API_URL=${adversarial.apiUrl}`,
          "--env",
          `SYSTEMVITALS_API_TOKEN=${adversarial.token}`,
          "--",
          "npx",
          "-y",
          "@systemvitals/mcp",
        ]);
        expect(tokenAfter).toBe("unset");
      } else {
        const output = execFileSync(
          "bash",
          [
            "-c",
            `curl() { printf '%s\\0' "$@"; }
${command}
printf 'token-after=%s' "\${SYSTEMVITALS_API_TOKEN-unset}"`,
          ],
          { encoding: "utf8", input: `${adversarial.token}\n` },
        );
        const [argumentsOutput, tokenAfter] = output.split("token-after=");
        const args = argumentsOutput.replace(/^\n/, "").split("\0").slice(0, -1);
        expect(args.slice(0, 6)).toEqual([
          "--request",
          "POST",
          adversarial.apiUrl,
          "--header",
          `Authorization: Bearer ${adversarial.token}`,
          "--header",
        ]);
        const body = JSON.parse(args.at(-1) ?? "");
        expect(body.variables).toEqual({ projectId: adversarial.projectId });
        expect(tokenAfter).toBe("unset");
      }
      expect(command).not.toContain(adversarial.token);
    },
  );

  it("never references a repository checkout or local MCP path", () => {
    for (const client of [
      "claude-code",
      "codex",
      "cursor",
      "universal",
    ] satisfies AgentClient[]) {
      const result = generateAgentConnectionConfig({ client, ...input });
      expect(result).toContain("@systemvitals/mcp");
      expect(result).not.toMatch(/integrations\/mcp|cli\/mcp|tsx/);
    }
  });
});
