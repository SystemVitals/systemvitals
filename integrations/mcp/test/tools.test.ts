import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Gql } from "../src/gql.js";
import { buildServer } from "../src/server.js";
import { tools } from "../src/tools.js";
import {
  EMAIL_VERIFICATION_TOOL_ALLOWLIST,
  emailVerificationLifecycleToolNames,
  isEmailVerificationLifecycleTool,
} from "./email-verification-tool-boundary.js";

// ---------------------------------------------------------------------------
// Fake gql factory — records calls so we can assert query/variables
// ---------------------------------------------------------------------------
function makeFakeGql(data: Record<string, unknown>): { gql: Gql; calls: { query: string; variables?: Record<string, unknown> }[] } {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const gql: Gql = async (query, variables) => {
    calls.push({ query, variables });
    return data;
  };
  return { gql, calls };
}

function findTool(name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool "${name}" not found`);
  return tool;
}

// ---------------------------------------------------------------------------
// list_projects
// ---------------------------------------------------------------------------
describe("list_projects", () => {
  it("returns each organization's inherited plan and creator with its projects", async () => {
    const fakeData = {
      me: {
        organizations: [
          {
            id: "org1",
            name: "Acme",
            plan: "SIGNAL",
            creatorUserId: "user1",
            creatorLabel: "owner@example.com",
            projects: [
              { id: "p1", name: "API Monitor", pingKey: "pk_abc" },
              { id: "p2", name: "Web Monitor", pingKey: "pk_def" },
            ],
          },
        ],
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("list_projects");
    const result = await tool.handler({}, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("me");
    expect(calls[0].query).toContain("plan");
    expect(calls[0].query).toContain("creatorUserId");
    expect(calls[0].query).toContain("creatorLabel");
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("SIGNAL");
    expect(result.content[0].text).toContain("owner@example.com");
    expect(result.content[0].text).toMatch(/inherited/i);
    expect(result.content[0].text).toContain("API Monitor");
    expect(result.content[0].text).toContain("Web Monitor");
  });
});

describe("safe API errors", () => {
  const cases = [
    [
      "Credential expired",
      "SystemVitals credential has expired. Create a new agent connection and update SYSTEMVITALS_API_TOKEN.",
    ],
    [
      "Credential revoked",
      "SystemVitals credential was revoked. Create a new agent connection and update SYSTEMVITALS_API_TOKEN.",
    ],
    [
      "Credential owner account suspended",
      "The account that owns this SystemVitals credential is suspended. Ask an administrator to restore the account before reconnecting.",
    ],
    [
      "Credential project no longer exists",
      "The project bound to this SystemVitals credential no longer exists. Connect the agent to an existing project.",
    ],
    [
      "Credential project is no longer accessible",
      "Access to the project bound to this SystemVitals credential was removed. Restore the owner's project membership or create a new agent connection.",
    ],
    [
      "Missing capability: checks:write",
      "This SystemVitals credential is missing checks:write. Create a connection with the checks:write capability.",
    ],
    [
      "Credential is bound to a different project",
      "This SystemVitals credential is bound to a different project. Use the bound project or connect with a credential for the requested project.",
    ],
    [
      "Unauthorized",
      "SystemVitals rejected this credential. Verify SYSTEMVITALS_API_TOKEN or create a new agent connection.",
    ],
    [
      "Check limit of 100 reached",
      "The account's shared check quota has been reached.",
    ],
    [
      "Forbidden resource",
      "This credential cannot perform that project operation.",
    ],
  ] as const;

  it.each(cases)("normalizes %s without leaking a bearer token", async (apiMessage, expected) => {
    const secret = "svt_do-not-leak";
    const gql: Gql = async () => {
      throw new Error(`${apiMessage}: ${secret}`);
    };

    await expect(
      findTool("list_checks").handler({ projectId: "p1" }, gql),
    ).rejects.toThrow(expected);
    await expect(
      findTool("list_checks").handler({ projectId: "p1" }, gql),
    ).rejects.not.toThrow(secret);
  });
});

// ---------------------------------------------------------------------------
// list_checks
// ---------------------------------------------------------------------------
describe("list_checks", () => {
  it("passes projectId variable and returns check names with status", async () => {
    const fakeData = {
      checks: [
        { id: "c1", name: "Heartbeat", type: "HEARTBEAT", status: "UP", pingSlug: "abc", intervalSeconds: 60, periodSeconds: null, lastEventAt: "2024-01-01T00:00:00Z" },
        { id: "c2", name: "HTTP Check", type: "HTTP", status: "DOWN", pingSlug: null, intervalSeconds: 30, periodSeconds: null, lastEventAt: null },
      ],
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("list_checks");
    const result = await tool.handler({ projectId: "p1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ projectId: "p1" });
    expect(calls[0].query).toContain("checks");
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("Heartbeat");
    expect(result.content[0].text).toContain("UP");
    expect(result.content[0].text).toContain("HTTP Check");
    expect(result.content[0].text).toContain("DOWN");
  });

  it("shows the cron schedule (and tz) instead of an empty interval for cron checks", async () => {
    const fakeData = {
      checks: [
        {
          id: "c3",
          name: "Nightly Backup",
          type: "HEARTBEAT",
          status: "UP",
          pingSlug: "xyz",
          intervalSeconds: null,
          periodSeconds: null,
          schedule: "0 9 * * *",
          tz: "America/New_York",
          nextExpectedAt: "2024-01-02T09:00:00Z",
          lastEventAt: "2024-01-01T09:00:00Z",
        },
      ],
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("list_checks");
    const result = await tool.handler({ projectId: "p1" }, gql);

    expect(calls[0].query).toContain("schedule");
    expect(calls[0].query).toContain("nextExpectedAt");
    const txt = result.content[0].text;
    expect(txt).toContain("0 9 * * *");
    expect(txt).toContain("America/New_York");
  });
});

// ---------------------------------------------------------------------------
// get_check
// ---------------------------------------------------------------------------
describe("get_check", () => {
  it("passes id variable and returns status, notification channels, and event info", async () => {
    const fakeData = {
      check: {
        id: "c1",
        name: "Heartbeat",
        type: "HEARTBEAT",
        status: "UP",
        pingSlug: "abc123",
        target: "https://example.com",
        intervalSeconds: 60,
        notificationChannelIds: ["channel-email", "channel-webhook"],
        events: [
          { id: "e1", status: "UP", timestamp: "2024-01-01T00:01:00Z", responseTimeMs: 120, error: null, statusCode: 200 },
          { id: "e2", status: "DOWN", timestamp: "2024-01-01T00:00:00Z", responseTimeMs: null, error: "timeout", statusCode: null },
        ],
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("get_check");
    const result = await tool.handler({ id: "c1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ id: "c1" });
    expect(calls[0].query).toContain("check");
    expect(calls[0].query).toContain("notificationChannelIds");
    expect(result.content[0].text).toContain("UP");
    expect(result.content[0].text).toContain(
      "Notification channels: channel-email, channel-webhook",
    );
    // Should mention events with actual event data from the timestamp/status
    const text = result.content[0].text;
    expect(text).toContain("2024-01-01T00:01:00Z");
    expect(text).toContain("2024-01-01T00:00:00Z");
  });

  it("accurately exposes an empty notification channel selection", async () => {
    const fakeData = {
      check: {
        id: "c-empty",
        name: "Quiet Check",
        type: "HTTP",
        status: "UP",
        pingSlug: null,
        target: "https://example.com/health",
        intervalSeconds: 60,
        periodSeconds: null,
        schedule: null,
        tz: null,
        nextExpectedAt: null,
        notificationChannelIds: [],
        events: [],
      },
    };
    const { gql } = makeFakeGql(fakeData);

    const result = await findTool("get_check").handler({ id: "c-empty" }, gql);

    expect(result.content[0].text).toContain("Notification channels: none");
  });

  it("shows the cron schedule and next expected time for cron checks", async () => {
    const fakeData = {
      check: {
        id: "c2",
        name: "Nightly Backup",
        type: "HEARTBEAT",
        status: "UP",
        pingSlug: "xyz",
        target: null,
        intervalSeconds: null,
        periodSeconds: null,
        schedule: "0 9 * * *",
        tz: "America/New_York",
        nextExpectedAt: "2024-01-02T09:00:00Z",
        notificationChannelIds: [],
        events: [],
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("get_check");
    const result = await tool.handler({ id: "c2" }, gql);

    expect(calls[0].query).toContain("schedule");
    expect(calls[0].query).toContain("nextExpectedAt");
    const text = result.content[0].text;
    expect(text).toContain("0 9 * * *");
    expect(text).toContain("America/New_York");
    expect(text).toContain("2024-01-02T09:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// set_check_channel_enabled
// ---------------------------------------------------------------------------
describe("set_check_channel_enabled", () => {
  it("has the exact public contract and validates every argument", () => {
    const tool = findTool("set_check_channel_enabled");

    expect(tool.description).toBe(
      "Enable or disable one notification channel for a check.",
    );
    expect(Object.keys(tool.inputSchema)).toEqual([
      "checkId",
      "channelId",
      "enabled",
    ]);
    expect(tool.inputSchema.checkId.safeParse("check-1").success).toBe(true);
    expect(tool.inputSchema.checkId.safeParse("").success).toBe(false);
    expect(tool.inputSchema.channelId.safeParse("channel-1").success).toBe(true);
    expect(tool.inputSchema.channelId.safeParse("").success).toBe(false);
    expect(tool.inputSchema.enabled.safeParse(true).success).toBe(true);
    expect(tool.inputSchema.enabled.safeParse(false).success).toBe(true);
    expect(tool.inputSchema.enabled.safeParse("true").success).toBe(false);
    expect(tool.inputSchema.enabled.safeParse(undefined).success).toBe(false);
  });

  it.each([
    {
      enabled: true,
      notificationChannelIds: ["channel-email", "channel-webhook"],
      expected: "channel-email, channel-webhook",
    },
    {
      enabled: false,
      notificationChannelIds: [],
      expected: "none",
    },
  ])(
    "sends the exact mutation variables when enabled is $enabled and returns the effective IDs",
    async ({ enabled, notificationChannelIds, expected }) => {
      const fakeData = {
        setCheckChannelEnabled: {
          id: "check-1",
          notificationChannelIds,
        },
      };
      const { gql, calls } = makeFakeGql(fakeData);

      const result = await findTool("set_check_channel_enabled").handler(
        {
          checkId: "check-1",
          channelId: "channel-email",
          enabled,
        },
        gql,
      );

      expect(calls).toHaveLength(1);
      expect(calls[0].query).toContain(
        "setCheckChannelEnabled(checkId: $checkId, channelId: $channelId, enabled: $enabled)",
      );
      expect(calls[0].query).toContain("notificationChannelIds");
      expect(calls[0].variables).toEqual({
        checkId: "check-1",
        channelId: "channel-email",
        enabled,
      });
      expect(result.content[0].text).toBe(
        `Check check-1 notification channels: ${expected}`,
      );
    },
  );

  it.each([
    [
      "Missing capability: checks:write",
      "This SystemVitals credential is missing checks:write. Create a connection with the checks:write capability.",
    ],
    [
      "Unauthorized: bearer svt_do-not-leak",
      "SystemVitals rejected this credential. Verify SYSTEMVITALS_API_TOKEN or create a new agent connection.",
    ],
  ])("surfaces %s through the standard safe error wrapper", async (message, expected) => {
    const gql: Gql = async () => {
      throw new Error(message);
    };

    await expect(
      findTool("set_check_channel_enabled").handler(
        {
          checkId: "check-1",
          channelId: "channel-email",
          enabled: true,
        },
        gql,
      ),
    ).rejects.toThrow(expected);
    await expect(
      findTool("set_check_channel_enabled").handler(
        {
          checkId: "check-1",
          channelId: "channel-email",
          enabled: true,
        },
        gql,
      ),
    ).rejects.not.toThrow("svt_do-not-leak");
  });
});

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------
describe("list_channels", () => {
  it("passes projectId and returns channel types", async () => {
    const fakeData = {
      channels: [
        {
          id: "ch1",
          type: "EMAIL",
          enabled: false,
          verificationStatus: "PENDING",
          verificationDeliveryStatus: "SENT",
          verificationExpiresAt: "2026-07-28T12:00:00.000Z",
        },
        {
          id: "ch2",
          type: "SLACK",
          enabled: false,
          verificationStatus: "NOT_REQUIRED",
          verificationDeliveryStatus: "NOT_REQUIRED",
          verificationExpiresAt: null,
        },
        {
          id: "ch3",
          type: "TELEGRAM",
          enabled: true,
          verificationStatus: "NOT_REQUIRED",
          verificationDeliveryStatus: "NOT_REQUIRED",
          verificationExpiresAt: null,
        },
      ],
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("list_channels");
    const result = await tool.handler({ projectId: "p1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ projectId: "p1" });
    expect(result.content[0].text).toContain("EMAIL");
    expect(result.content[0].text).toContain("SLACK");
    expect(result.content[0].text).toContain("TELEGRAM");
    expect(calls[0].query).toContain("verificationStatus");
    expect(calls[0].query).toContain("verificationDeliveryStatus");
    expect(calls[0].query).toContain("verificationExpiresAt");
    expect(result.content[0].text).toContain("PENDING");
    expect(result.content[0].text).toContain("SENT");
    expect(result.content[0].text).toContain("2026-07-28T12:00:00.000Z");
    expect(tool.description).toMatch(/already-connected Telegram/i);
  });
});

// ---------------------------------------------------------------------------
// create_heartbeat_check
// ---------------------------------------------------------------------------
describe("create_heartbeat_check", () => {
  it("calls gql with createCheck mutation and returns new id in text", async () => {
    const fakeData = { createCheck: { id: "chk_new1" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("create_heartbeat_check");
    const result = await tool.handler(
      { projectId: "p1", name: "Daily Job", periodSeconds: 86400, graceSeconds: 300 },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("createCheck");
    expect(calls[0].variables).toEqual({
      projectId: "p1",
      name: "Daily Job",
      periodSeconds: 86400,
      graceSeconds: 300,
    });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("chk_new1");
  });

  it("accepts a cron schedule + tz instead of periodSeconds", async () => {
    const fakeData = { createCheck: { id: "chk_cron1" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("create_heartbeat_check");
    const result = await tool.handler(
      {
        projectId: "p1",
        name: "Nightly Backup",
        schedule: "0 9 * * *",
        tz: "America/New_York",
        graceSeconds: 600,
      },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("createCheck");
    expect(calls[0].query).toContain("$schedule: String");
    expect(calls[0].query).toContain("$tz: String");
    expect(calls[0].variables).toEqual({
      projectId: "p1",
      name: "Nightly Backup",
      schedule: "0 9 * * *",
      tz: "America/New_York",
      graceSeconds: 600,
    });
    expect(result.content[0].text).toContain("chk_cron1");
  });
});

// ---------------------------------------------------------------------------
// create_active_check
// ---------------------------------------------------------------------------
describe("create_active_check", () => {
  it("calls gql with createActiveCheck mutation passing type/target/interval", async () => {
    const fakeData = { createActiveCheck: { id: "chk_act1" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("create_active_check");
    const result = await tool.handler(
      {
        projectId: "p2",
        name: "Homepage",
        type: "HTTP",
        target: "https://example.com",
        intervalSeconds: 60,
        timeoutMs: 5000,
        method: "GET",
        expectedStatus: 200,
      },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("createActiveCheck");
    expect(calls[0].variables).toMatchObject({
      projectId: "p2",
      name: "Homepage",
      type: "HTTP",
      target: "https://example.com",
      intervalSeconds: 60,
      timeoutMs: 5000,
    });
    expect(result.content[0].text).toContain("chk_act1");
  });

  it("works without optional method and expectedStatus", async () => {
    const fakeData = { createActiveCheck: { id: "chk_act2" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("create_active_check");
    await tool.handler(
      {
        projectId: "p2",
        name: "TCP Check",
        type: "TCP",
        target: "db.example.com:5432",
        intervalSeconds: 30,
        timeoutMs: 3000,
      },
      gql,
    );

    expect(calls[0].variables).toMatchObject({
      type: "TCP",
      target: "db.example.com:5432",
      intervalSeconds: 30,
      timeoutMs: 3000,
    });
  });
});

// ---------------------------------------------------------------------------
// pause_check
// ---------------------------------------------------------------------------
describe("pause_check", () => {
  it("calls gql with pauseCheck mutation and returns confirmation text", async () => {
    const fakeData = { pauseCheck: { id: "c1", status: "PAUSED" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("pause_check");
    const result = await tool.handler({ id: "c1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("pauseCheck");
    expect(calls[0].variables).toEqual({ id: "c1" });
    const txt = result.content[0].text.toLowerCase();
    expect(txt).toMatch(/pause|paused/);
  });
});

// ---------------------------------------------------------------------------
// resume_check
// ---------------------------------------------------------------------------
describe("resume_check", () => {
  it("calls gql with resumeCheck mutation and returns confirmation text", async () => {
    const fakeData = { resumeCheck: { id: "c1", status: "UP" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("resume_check");
    const result = await tool.handler({ id: "c1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("resumeCheck");
    expect(calls[0].variables).toEqual({ id: "c1" });
    const txt = result.content[0].text.toLowerCase();
    expect(txt).toMatch(/resume|resumed/);
  });
});

// ---------------------------------------------------------------------------
// delete_check
// ---------------------------------------------------------------------------
describe("delete_check", () => {
  it("calls gql with deleteCheck mutation and returns confirmation text", async () => {
    const fakeData = { deleteCheck: true };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("delete_check");
    const result = await tool.handler({ id: "c1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("deleteCheck");
    expect(calls[0].variables).toEqual({ id: "c1" });
    const txt = result.content[0].text.toLowerCase();
    expect(txt).toMatch(/delet/);
  });
});

// ---------------------------------------------------------------------------
// create_channel
// ---------------------------------------------------------------------------
describe("create_channel", () => {
  it("requires the interactive managed-bot handshake for Telegram", () => {
    const tool = findTool("create_channel");
    expect(tool.description).toMatch(/Telegram.*interactive.*handshake/i);
    const parsed = tool.inputSchema.type.safeParse("TELEGRAM");
    expect(parsed.success).toBe(false);
  });

  it("rejects Telegram through the registered MCP execution path before channel GraphQL", async () => {
    let createChannelCalls = 0;
    const gql: Gql = async (query) => {
      if (query.includes("apiCredential")) {
        return {
          apiCredential: {
            authKind: "session",
            credentialMode: "SESSION",
            capabilities: [],
            projectId: null,
            projectName: null,
          },
        };
      }
      createChannelCalls += 1;
      return { createChannel: { id: "unexpected" } };
    };
    const { server } = await buildServer(gql);
    const client = new Client({ name: "tools-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "create_channel",
        arguments: {
          projectId: "p1",
          type: "TELEGRAM",
          configJson: "{}",
        },
      });
      expect(result).toMatchObject({
        isError: true,
        content: [
          {
            type: "text",
            text: expect.stringMatching(/MCP error -32602.*input validation/is),
          },
        ],
      });
      expect(createChannelCalls).toBe(0);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it("reports pending email verification and exact sent guidance", async () => {
    const fakeData = {
      createChannel: {
        id: "ch_new1",
        verificationStatus: "PENDING",
        verificationDeliveryStatus: "SENT",
        verificationExpiresAt: "2026-07-28T12:00:00.000Z",
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("create_channel");
    const result = await tool.handler(
      { projectId: "p1", type: "EMAIL", configJson: '{"email":"ops@example.com"}' },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("createChannel");
    expect(calls[0].variables).toEqual({
      projectId: "p1",
      type: "EMAIL",
      configJson: '{"email":"ops@example.com"}',
    });
    expect(calls[0].query).toContain("verificationStatus");
    expect(calls[0].query).toContain("verificationDeliveryStatus");
    expect(calls[0].query).toContain("verificationExpiresAt");
    expect(result.content[0].text).toBe(
      "Channel created. id: ch_new1\nStatus: PENDING\nVerification email sent; alerts remain inactive until the recipient confirms.",
    );
  });

  it("reports NOT_SENT email delivery with accurate resend guidance", async () => {
    const fakeData = {
      createChannel: {
        id: "ch_new2",
        verificationStatus: "PENDING",
        verificationDeliveryStatus: "NOT_SENT",
        verificationExpiresAt: "2026-07-28T12:00:00.000Z",
      },
    };
    const { gql } = makeFakeGql(fakeData);

    const result = await findTool("create_channel").handler(
      { projectId: "p1", type: "EMAIL", configJson: '{"email":"ops@example.com"}' },
      gql,
    );

    expect(result.content[0].text).toContain("Status: PENDING");
    expect(result.content[0].text).toContain("Verification email was not sent.");
    expect(result.content[0].text).toContain(
      "Use resend_email_channel_verification with channel ID ch_new2 to try again.",
    );
  });
});

// ---------------------------------------------------------------------------
// resend_email_channel_verification
// ---------------------------------------------------------------------------
describe("resend_email_channel_verification", () => {
  it("calls the authenticated resend mutation scoped only by channel ID", async () => {
    const fakeData = {
      resendEmailChannelVerification: {
        id: "ch1",
        verificationStatus: "PENDING",
        verificationDeliveryStatus: "SENT",
        verificationExpiresAt: "2026-07-28T12:00:00.000Z",
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);

    const result = await findTool("resend_email_channel_verification").handler(
      { channelId: "ch1" },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("resendEmailChannelVerification");
    expect(calls[0].query).toContain("verificationStatus");
    expect(calls[0].query).toContain("verificationDeliveryStatus");
    expect(calls[0].query).toContain("verificationExpiresAt");
    expect(calls[0].variables).toEqual({ channelId: "ch1" });
    expect(Object.keys(findTool("resend_email_channel_verification").inputSchema)).toEqual([
      "channelId",
    ]);
    expect(result.content[0].text).toContain("Verification email resent.");
  });

  it("reports NOT_SENT delivery with retry guidance", async () => {
    const fakeData = {
      resendEmailChannelVerification: {
        id: "ch1",
        verificationStatus: "PENDING",
        verificationDeliveryStatus: "NOT_SENT",
        verificationExpiresAt: "2026-07-28T12:00:00.000Z",
      },
    };
    const { gql } = makeFakeGql(fakeData);

    const result = await findTool("resend_email_channel_verification").handler(
      { channelId: "ch1" },
      gql,
    );

    expect(result.content[0].text).toContain("Verification email was not sent.");
    expect(result.content[0].text).toMatch(/try again/i);
  });

  it("preserves the API cooldown error so callers know when to retry", async () => {
    const gql: Gql = async () => {
      throw new Error("Email verification was sent less than 60 seconds ago");
    };

    await expect(
      findTool("resend_email_channel_verification").handler(
        { channelId: "ch1" },
        gql,
      ),
    ).rejects.toThrow("Email verification was sent less than 60 seconds ago");
  });
});

describe("email verification tool boundary", () => {
  it.each([
    "approve_email_channel",
    "mark_email_verified",
    "email_channel_confirmation",
    "resend_and_confirm_email_channel",
    "enable_email_channel",
    "email_channel_enable",
  ])("classifies %s as an email verification lifecycle tool", (name) => {
    expect(isEmailVerificationLifecycleTool(name)).toBe(true);
  });

  it.each([
    "create_channel",
    "invite_member",
    "update_member_role",
    "regenerate_ping_key",
    "send_email_digest",
    "enable_channel",
    "email_channel",
  ])("does not classify unrelated tool %s as verification lifecycle", (name) => {
    expect(isEmailVerificationLifecycleTool(name)).toBe(false);
  });

  it("allows only resend across directly defined lifecycle tools", () => {
    expect(
      emailVerificationLifecycleToolNames(tools.map(({ name }) => name)),
    ).toEqual(EMAIL_VERIFICATION_TOOL_ALLOWLIST);
  });
});

// ---------------------------------------------------------------------------
// delete_channel
// ---------------------------------------------------------------------------
describe("delete_channel", () => {
  it("calls gql with deleteChannel mutation and returns confirmation text", async () => {
    const fakeData = { deleteChannel: true };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("delete_channel");
    const result = await tool.handler({ id: "ch1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("deleteChannel");
    expect(calls[0].variables).toEqual({ id: "ch1" });
    const txt = result.content[0].text.toLowerCase();
    expect(txt).toMatch(/delet/);
    expect(tool.description).toMatch(/already-connected Telegram/i);
  });
});

// ---------------------------------------------------------------------------
// create_project
// ---------------------------------------------------------------------------
describe("create_project", () => {
  it("calls gql with createProject mutation and returns new project id", async () => {
    const fakeData = { createProject: { id: "proj_new1" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("create_project");
    const result = await tool.handler(
      { organizationId: "org1", name: "My Project" },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("createProject");
    expect(calls[0].variables).toEqual({ organizationId: "org1", name: "My Project" });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("proj_new1");
  });
});

// ---------------------------------------------------------------------------
// regenerate_ping_key
// ---------------------------------------------------------------------------
describe("regenerate_ping_key", () => {
  it("calls gql with regeneratePingKey mutation and returns new pingKey", async () => {
    const fakeData = { regeneratePingKey: { id: "p1", pingKey: "pk_newkey123" } };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("regenerate_ping_key");
    const result = await tool.handler({ projectId: "p1" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("regeneratePingKey");
    expect(calls[0].variables).toEqual({ projectId: "p1" });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("pk_newkey123");
  });
});

// ---------------------------------------------------------------------------
// update_check
// ---------------------------------------------------------------------------
describe("update_check", () => {
  it("sends id as its own variable and only the supplied keys inside input", async () => {
    const fakeData = {
      updateCheck: {
        id: "c1",
        name: "Renamed Check",
        type: "HEARTBEAT",
        periodSeconds: 3600,
        graceSeconds: 120,
        schedule: null,
        tz: null,
        target: null,
        method: null,
        expectedStatus: null,
        intervalSeconds: null,
        timeoutMs: null,
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("update_check");
    const result = await tool.handler(
      { id: "c1", name: "Renamed Check", periodSeconds: 3600, graceSeconds: 120 },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("updateCheck");
    expect(calls[0].query).toContain("$id: ID!");
    expect(calls[0].query).toContain("$input: UpdateCheckInput!");
    expect(calls[0].variables).toEqual({
      id: "c1",
      input: {
        name: "Renamed Check",
        periodSeconds: 3600,
        graceSeconds: 120,
      },
    });
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("c1");
    expect(result.content[0].text).toContain("Renamed Check");
  });

  it("works with only id — input has no keys, and no key is ever explicitly null", async () => {
    const fakeData = {
      updateCheck: {
        id: "c2",
        name: "Old Name",
        type: "HEARTBEAT",
        periodSeconds: null,
        graceSeconds: null,
        schedule: null,
        tz: null,
        target: null,
        method: null,
        expectedStatus: null,
        intervalSeconds: null,
        timeoutMs: null,
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("update_check");
    await tool.handler({ id: "c2" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("updateCheck");
    expect(calls[0].variables).toEqual({ id: "c2", input: {} });
  });

  it("sends the full set of active-check fields when supplied, with no PING option offered", async () => {
    const fakeData = {
      updateCheck: {
        id: "c3",
        name: "API Health",
        type: "HTTP",
        periodSeconds: null,
        graceSeconds: null,
        schedule: null,
        tz: null,
        target: "https://example.com/health",
        method: "GET",
        expectedStatus: 200,
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("update_check");
    await tool.handler(
      {
        id: "c3",
        type: "HTTP",
        target: "https://example.com/health",
        method: "GET",
        expectedStatus: 200,
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
      gql,
    );

    expect(calls[0].variables).toEqual({
      id: "c3",
      input: {
        type: "HTTP",
        target: "https://example.com/health",
        method: "GET",
        expectedStatus: 200,
        intervalSeconds: 60,
        timeoutMs: 5000,
      },
    });

    const tool2 = findTool("update_check");
    const typeField = tool2.inputSchema["type"];
    // The type enum must offer only HEARTBEAT, HTTP, TCP — never PING.
    expect(typeField.safeParse("HEARTBEAT").success).toBe(true);
    expect(typeField.safeParse("HTTP").success).toBe(true);
    expect(typeField.safeParse("TCP").success).toBe(true);
    expect(typeField.safeParse("PING").success).toBe(false);
  });

  it("accepts a slug and forwards it inside input", async () => {
    const fakeData = {
      updateCheck: {
        id: "c5",
        name: "Renamed Check",
        slug: "renamed-check",
        type: "HEARTBEAT",
        periodSeconds: 3600,
        graceSeconds: 120,
        schedule: null,
        tz: null,
        target: null,
        method: null,
        expectedStatus: null,
        intervalSeconds: null,
        timeoutMs: null,
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("update_check");
    await tool.handler({ id: "c5", slug: "renamed-check" }, gql);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("slug");
    expect(calls[0].variables).toEqual({
      id: "c5",
      input: {
        slug: "renamed-check",
      },
    });
  });

  it("sends schedule and tz as strings, not numbers", async () => {
    const fakeData = {
      updateCheck: {
        id: "c4",
        name: "Nightly Job",
        type: "HEARTBEAT",
        periodSeconds: null,
        graceSeconds: 300,
        schedule: "0 9 * * *",
        tz: "America/New_York",
        target: null,
        method: null,
        expectedStatus: null,
        intervalSeconds: null,
        timeoutMs: null,
      },
    };
    const { gql, calls } = makeFakeGql(fakeData);
    const tool = findTool("update_check");
    await tool.handler(
      { id: "c4", schedule: "0 9 * * *", tz: "America/New_York", graceSeconds: 300 },
      gql,
    );

    expect(calls[0].variables).toEqual({
      id: "c4",
      input: {
        schedule: "0 9 * * *",
        tz: "America/New_York",
        graceSeconds: 300,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// member tools
// ---------------------------------------------------------------------------
describe("member tools", () => {
  it("list_members renders one line per member", async () => {
    const { gql, calls } = makeFakeGql({
      organizationMembers: [
        { id: "m1", email: "owner@example.com", role: "OWNER" },
        { id: "m2", email: "dev@example.com", role: "MEMBER" },
      ],
    });

    const res = await findTool("list_members").handler(
      { organizationId: "org1" },
      gql,
    );

    expect(calls[0].variables).toEqual({ organizationId: "org1" });
    expect(res.content[0].text).toContain("owner@example.com");
    expect(res.content[0].text).toContain("OWNER");
    expect(res.content[0].text).toContain("dev@example.com");
  });

  it("invite_member defaults to MEMBER without returning an acceptance secret", async () => {
    const { gql, calls } = makeFakeGql({
      inviteMember: {
        id: "inv1",
        email: "new@example.com",
        role: "MEMBER",
        acceptUrl: "http://localhost:9999/invite/tok1",
      },
    });

    const res = await findTool("invite_member").handler(
      { organizationId: "org1", email: "new@example.com" },
      gql,
    );

    expect(calls[0].variables).toEqual({
      organizationId: "org1",
      email: "new@example.com",
      role: "MEMBER",
    });
    expect(res.content[0].text).toContain("new@example.com");
    expect(res.content[0].text).not.toContain("tok1");
  });

  it("remove_member reports success", async () => {
    const { gql } = makeFakeGql({ removeMember: true });

    const res = await findTool("remove_member").handler(
      { membershipId: "m2" },
      gql,
    );

    expect(res.content[0].text).toMatch(/removed/i);
  });

  it("revoke_invite passes the invite id and reports success", async () => {
    const { gql, calls } = makeFakeGql({ revokeInvite: true });

    const res = await findTool("revoke_invite").handler(
      { inviteId: "inv1" },
      gql,
    );

    expect(calls[0].variables).toEqual({ inviteId: "inv1" });
    expect(res.content[0].text).toMatch(/revoked/i);
  });

  it("update_member_role passes the membership id and role and reports the new role", async () => {
    const { gql, calls } = makeFakeGql({
      updateMemberRole: { id: "m2", role: "ADMIN" },
    });

    const res = await findTool("update_member_role").handler(
      { membershipId: "m2", role: "ADMIN" },
      gql,
    );

    expect(calls[0].variables).toEqual({ membershipId: "m2", role: "ADMIN" });
    expect(res.content[0].text).toContain("ADMIN");
  });
});

// ---------------------------------------------------------------------------
// organization tools
// ---------------------------------------------------------------------------
describe("organization tools", () => {
  it("describes create_organization account plan and shared quota inheritance exactly", () => {
    expect(findTool("create_organization").description).toBe(
      "Create a new organization (team). The caller becomes its owner, and the organization inherits the creator account's effective plan and shared quota. Subject to the account's organization capacity.",
    );
  });

  it("create_organization returns the new org with inherited plan and creator", async () => {
    const { gql, calls } = makeFakeGql({
      createOrganization: {
        id: "org1",
        name: "Acme",
        slug: "acme",
        role: "OWNER",
        plan: "SOLO",
        creatorUserId: "user1",
        creatorLabel: "owner@example.com",
      },
    });
    const res = await findTool("create_organization").handler({ name: "Acme" }, gql);
    expect(calls[0].variables).toEqual({ name: "Acme" });
    expect(calls[0].query).toContain("creatorUserId");
    expect(calls[0].query).toContain("creatorLabel");
    expect(res.content[0].text).toContain("acme");
    expect(res.content[0].text).toContain("SOLO");
    expect(res.content[0].text).toContain("owner@example.com");
    expect(res.content[0].text).toMatch(/inherited/i);
  });

  it("update_organization updates the name only", async () => {
    const { gql, calls } = makeFakeGql({
      updateOrganization: { id: "org1", name: "Renamed", slug: "acme" },
    });
    const res = await findTool("update_organization").handler(
      { organizationId: "org1", name: "Renamed" },
      gql,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("updateOrganization(");
    expect(calls[0].variables).toEqual({ organizationId: "org1", name: "Renamed" });
    expect(res.content[0].text).toContain('"Renamed"');
    expect(res.content[0].text).toContain("acme");
  });

  it("update_organization updates the slug only", async () => {
    const { gql, calls } = makeFakeGql({
      updateOrganization: { id: "org1", name: "Acme", slug: "new-slug" },
    });

    const res = await findTool("update_organization").handler(
      { organizationId: "org1", slug: "new-slug" },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("updateOrganization(");
    expect(calls[0].variables).toEqual({
      organizationId: "org1",
      slug: "new-slug",
    });
    expect(res.content[0].text).toContain('"Acme"');
    expect(res.content[0].text).toContain("new-slug");
  });

  it("update_organization updates both name and slug in exactly one GraphQL call", async () => {
    const { gql, calls } = makeFakeGql({
      updateOrganization: {
        id: "org1",
        name: "Renamed",
        slug: "new-slug",
      },
    });

    const res = await findTool("update_organization").handler(
      { organizationId: "org1", name: "Renamed", slug: "new-slug" },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("updateOrganization(");
    expect(calls[0].variables).toEqual({
      organizationId: "org1",
      name: "Renamed",
      slug: "new-slug",
    });
    expect(res.content[0].text).toContain('"Renamed"');
    expect(res.content[0].text).toContain("new-slug");
  });

  it("update_organization rejects an update without a name or slug", async () => {
    const { gql, calls } = makeFakeGql({});

    await expect(
      findTool("update_organization").handler({ organizationId: "org1" }, gql),
    ).rejects.toThrow(/name or slug/i);
    expect(calls).toHaveLength(0);
  });

  it("leave_organization calls leaveOrganization with the explicit organization id", async () => {
    const { gql, calls } = makeFakeGql({ leaveOrganization: true });

    const res = await findTool("leave_organization").handler(
      { organizationId: "org1" },
      gql,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("leaveOrganization(");
    expect(calls[0].variables).toEqual({ organizationId: "org1" });
    expect(res.content[0].text).toMatch(/left/i);
  });

  it("delete_organization reports success", async () => {
    const { gql } = makeFakeGql({ deleteOrganization: true });
    const res = await findTool("delete_organization").handler(
      { organizationId: "org1" },
      gql,
    );
    expect(res.content[0].text).toMatch(/deleted/i);
  });

  it("registers transfer_organization_creatorship with the capacity constraints", () => {
    const tool = findTool("transfer_organization_creatorship");

    expect(tool.description).toBe(
      "Transfer organization creatorship to a recipient who must already be an owner. Plan and shared-quota attribution move to the recipient account. The transfer is rejected if that account lacks organization or check capacity.",
    );
  });

  it("transfers creatorship with the exact GraphQL operation and unchanged variables", async () => {
    const { gql, calls } = makeFakeGql({
      transferOrganizationCreatorship: {
        id: "org1",
        name: "Acme",
        creatorUserId: "user2",
        creatorLabel: "recipient@example.com",
        plan: "FLEET",
      },
    });
    const variables = {
      organizationId: "org1",
      newCreatorUserId: "user2",
    };

    const result = await findTool("transfer_organization_creatorship").handler(
      variables,
      gql,
    );

    expect(calls).toEqual([
      {
        query: `mutation transferOrganizationCreatorship(
  $organizationId: ID!
  $newCreatorUserId: ID!
) {
  transferOrganizationCreatorship(
    organizationId: $organizationId
    newCreatorUserId: $newCreatorUserId
  ) {
    id
    name
    creatorUserId
    creatorLabel
    plan
  }
}`,
        variables,
      },
    ]);
    expect(calls[0].variables).toBe(variables);
    expect(result.content[0].text).toContain("recipient@example.com");
    expect(result.content[0].text).toContain("FLEET");
    expect(result.content[0].text).toMatch(/inherited/i);
  });
});

describe("tool surface safety", () => {
  it("requires every ID input to be nonempty", () => {
    for (const tool of tools) {
      for (const [field, schema] of Object.entries(tool.inputSchema)) {
        if (field.toLowerCase().endsWith("id")) {
          expect(
            schema.safeParse("").success,
            `${tool.name}.${field} accepted an empty ID`,
          ).toBe(false);
        }
      }
    }
  });

  it("does not expose billing, checkout, portal, or Stripe tools", () => {
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/billing|checkout|portal|stripe/i),
      ]),
    );
  });

  it("does not expose invite acceptance secrets", async () => {
    const { gql } = makeFakeGql({
      inviteMember: {
        id: "inv1",
        email: "new@example.com",
        role: "MEMBER",
        acceptUrl: "https://systemvitals.example/invite/super-secret-token",
      },
    });

    const result = await findTool("invite_member").handler(
      { organizationId: "org1", email: "new@example.com" },
      gql,
    );

    expect(result.content[0].text).not.toContain("super-secret-token");
    expect(result.content[0].text).not.toContain("/invite/");
  });

  it("keeps API errors useful while redacting invite secrets", async () => {
    const gql: Gql = async () => {
      throw new Error(
        "Recipient exceeds organization capacity. Invite: https://systemvitals.example/invite/super-secret-token",
      );
    };

    await expect(
      findTool("transfer_organization_creatorship").handler(
        { organizationId: "org1", newCreatorUserId: "user2" },
        gql,
      ),
    ).rejects.toThrow(
      "Recipient exceeds organization capacity. Invite: [redacted]",
    );
  });
});
