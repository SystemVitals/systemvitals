/**
 * SystemVitals MCP read tools.
 *
 * Each ToolDef handler is a PURE function that takes (args, gql) so it can be
 * unit-tested with a fake gql — no live server or DB needed.
 *
 * GraphQL field names mirror frontend/lib/queries.ts exactly.
 */

import { z } from "zod";
import { normalizeGqlError, type Gql } from "./gql.js";

export type ToolContent = { type: "text"; text: string };
export type ToolResult = { content: ToolContent[] };

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>, gql: Gql) => Promise<ToolResult>;
};

// ---------------------------------------------------------------------------
// Typed response shapes (inline, no `any`)
// ---------------------------------------------------------------------------

interface CreatedId {
  id: string;
}

interface CheckStatus {
  id: string;
  status: string;
}

interface CreateCheckResponse {
  createCheck: CreatedId;
}

interface CreateActiveCheckResponse {
  createActiveCheck: CreatedId;
}

interface PauseCheckResponse {
  pauseCheck: CheckStatus;
}

interface ResumeCheckResponse {
  resumeCheck: CheckStatus;
}

interface SetCheckChannelEnabledResponse {
  setCheckChannelEnabled: {
    id: string;
    notificationChannelIds: string[];
  };
}

interface CreateChannelResponse {
  createChannel: Channel;
}

interface ResendEmailChannelVerificationResponse {
  resendEmailChannelVerification: Channel;
}

interface RegeneratePingKeyResponse {
  regeneratePingKey: { id: string; pingKey: string };
}

interface UpdateCheckResponse {
  updateCheck: {
    id: string;
    name: string;
    slug: string;
    type: string;
    periodSeconds: number | null;
    graceSeconds: number | null;
    schedule: string | null;
    tz: string | null;
    target: string | null;
    method: string | null;
    expectedStatus: number | null;
    intervalSeconds: number | null;
    timeoutMs: number | null;
  };
}

interface Project {
  id: string;
  name: string;
  pingKey: string;
}

interface Organization {
  id: string;
  name: string;
  plan: string;
  creatorUserId: string;
  creatorLabel: string;
  projects: Project[];
}

interface MeResponse {
  me: {
    organizations: Organization[];
  };
}

interface Check {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  pingSlug: string | null;
  intervalSeconds: number | null;
  periodSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  nextExpectedAt: string | null;
  lastEventAt: string | null;
}

interface ChecksResponse {
  checks: Check[];
}

interface CheckEvent {
  id: string;
  status: string;
  timestamp: string;
  responseTimeMs: number | null;
  error: string | null;
  statusCode: number | null;
}

interface CheckDetail {
  id: string;
  name: string;
  slug: string;
  type: string;
  status: string;
  pingSlug: string | null;
  target: string | null;
  intervalSeconds: number | null;
  periodSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  nextExpectedAt: string | null;
  notificationChannelIds: string[];
  events: CheckEvent[];
}

interface CheckResponse {
  check: CheckDetail;
}

interface Channel {
  id: string;
  type: string;
  enabled: boolean;
  verificationStatus: string;
  verificationDeliveryStatus: string;
  verificationExpiresAt: string | null;
}

interface ChannelsResponse {
  channels: Channel[];
}

interface MemberRef {
  id: string;
  email: string;
  role: string;
}

interface ListMembersResponse {
  organizationMembers: MemberRef[];
}

interface InviteMemberResponse {
  inviteMember: {
    id: string;
    email: string;
    role: string;
  };
}

interface UpdateMemberRoleResponse {
  updateMemberRole: { id: string; role: string };
}

interface CreateOrganizationResponse {
  createOrganization: {
    id: string;
    name: string;
    slug: string;
    role: string;
    plan: string;
    creatorUserId: string;
    creatorLabel: string;
  };
}

interface UpdateOrganizationResponse {
  updateOrganization: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    creatorUserId: string;
    creatorLabel: string;
  };
}

interface TransferOrganizationCreatorshipResponse {
  transferOrganizationCreatorship: {
    id: string;
    name: string;
    creatorUserId: string;
    creatorLabel: string;
    plan: string;
  };
}

// ---------------------------------------------------------------------------
// Helper: narrow unknown gql result to a typed shape via cast (safe because
// the API guarantees the shape; the Gql type returns Record<string,unknown>)
// ---------------------------------------------------------------------------
function cast<T>(data: Record<string, unknown>): T {
  return data as unknown as T;
}

function text(str: string): ToolResult {
  return { content: [{ type: "text", text: str }] };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const listProjects: ToolDef = {
  name: "list_projects",
  description:
    "List all organizations and their projects accessible with the current API token.",
  inputSchema: {},
  handler: async (_args, gql) => {
    const data = await gql(`{
      me {
        organizations {
          id
          name
          plan
          creatorUserId
          creatorLabel
          projects {
            id
            name
            pingKey
          }
        }
      }
    }`);

    const { me } = cast<MeResponse>(data);
    const lines: string[] = [];

    for (const org of me.organizations) {
      lines.push(
        `Organization: ${org.name} (${org.id}) — ${org.plan} plan inherited from ${org.creatorLabel} (${org.creatorUserId})`,
      );
      if (org.projects.length === 0) {
        lines.push("  (no projects)");
      } else {
        for (const p of org.projects) {
          lines.push(`  Project: ${p.name} (id: ${p.id}, pingKey: ${p.pingKey})`);
        }
      }
    }

    return text(lines.length > 0 ? lines.join("\n") : "No organizations found.");
  },
};

const listChecks: ToolDef = {
  name: "list_checks",
  description: "List all checks for a given project.",
  inputSchema: { projectId: z.string().min(1).describe("The project ID to list checks for") },
  handler: async (args, gql) => {
    const projectId = args["projectId"] as string;
    const data = await gql(
      `query checks($projectId: ID!) {
        checks(projectId: $projectId) {
          id
          name
          slug
          type
          status
          pingSlug
          intervalSeconds
          periodSeconds
          schedule
          tz
          nextExpectedAt
          lastEventAt
        }
      }`,
      { projectId },
    );

    const { checks } = cast<ChecksResponse>(data);
    if (checks.length === 0) {
      return text(`No checks found for project ${projectId}.`);
    }

    const lines = checks.map((c) => {
      const interval = c.schedule
        ? `schedule ${c.schedule} (${c.tz ?? "UTC"})`
        : c.intervalSeconds != null
          ? `every ${c.intervalSeconds}s`
          : c.periodSeconds != null
            ? `period ${c.periodSeconds}s`
            : "";
      const next = c.nextExpectedAt ? ` next: ${c.nextExpectedAt}` : "";
      const last = c.lastEventAt ? `last: ${c.lastEventAt}` : "no events yet";
      const slug = c.pingSlug ? ` slug: ${c.pingSlug}` : "";
      return `- ${c.name} [${c.type}] status: ${c.status}${slug} ${interval} (${last})${next}`;
    });

    return text(`Checks for project ${projectId}:\n${lines.join("\n")}`);
  },
};

const getCheck: ToolDef = {
  name: "get_check",
  description: "Get details and recent events for a specific check.",
  inputSchema: { id: z.string().min(1).describe("The check ID") },
  handler: async (args, gql) => {
    const id = args["id"] as string;
    const data = await gql(
      `query check($id: ID!) {
        check(id: $id) {
          id
          name
          slug
          type
          status
          pingSlug
          target
          intervalSeconds
          periodSeconds
          schedule
          tz
          nextExpectedAt
          notificationChannelIds
          events(limit: 20) {
            id
            status
            timestamp
            responseTimeMs
            error
            statusCode
          }
        }
      }`,
      { id },
    );

    const { check } = cast<CheckResponse>(data);
    const header = [
      `Check: ${check.name} (${check.id})`,
      `Type: ${check.type}`,
      `Status: ${check.status}`,
      check.target ? `Target: ${check.target}` : null,
      check.pingSlug ? `Ping slug: ${check.pingSlug}` : null,
      check.schedule
        ? `Schedule: ${check.schedule} (${check.tz ?? "UTC"})`
        : check.intervalSeconds != null
          ? `Interval: ${check.intervalSeconds}s`
          : check.periodSeconds != null
            ? `Period: ${check.periodSeconds}s`
            : null,
      check.nextExpectedAt ? `Next expected: ${check.nextExpectedAt}` : null,
      `Notification channels: ${
        check.notificationChannelIds.length > 0
          ? check.notificationChannelIds.join(", ")
          : "none"
      }`,
      `Events (last ${check.events.length}):`,
    ]
      .filter(Boolean)
      .join("\n");

    const eventLines = check.events.map((e) => {
      const rt = e.responseTimeMs != null ? ` ${e.responseTimeMs}ms` : "";
      const sc = e.statusCode != null ? ` [${e.statusCode}]` : "";
      const err = e.error ? ` error: ${e.error}` : "";
      return `  [${e.timestamp}] ${e.status}${sc}${rt}${err}`;
    });

    return text([header, ...eventLines].join("\n"));
  },
};

const listChannels: ToolDef = {
  name: "list_channels",
  description:
    "List notification channels for a given project, including already-connected Telegram rows.",
  inputSchema: { projectId: z.string().min(1).describe("The project ID") },
  handler: async (args, gql) => {
    const projectId = args["projectId"] as string;
    const data = await gql(
      `query channels($projectId: ID!) {
        channels(projectId: $projectId) {
          id
          type
          enabled
          verificationStatus
          verificationDeliveryStatus
          verificationExpiresAt
        }
      }`,
      { projectId },
    );

    const { channels } = cast<ChannelsResponse>(data);
    if (channels.length === 0) {
      return text(`No channels found for project ${projectId}.`);
    }

    const lines = channels.map((ch) => {
      const verification =
        ch.verificationStatus === "NOT_REQUIRED"
          ? ""
          : ` verification: ${ch.verificationStatus}, delivery: ${ch.verificationDeliveryStatus}${
              ch.verificationExpiresAt
                ? `, expires: ${ch.verificationExpiresAt}`
                : ""
            }`;
      return `- ${ch.type} (id: ${ch.id}) enabled: ${ch.enabled}${verification}`;
    });

    return text(`Channels for project ${projectId}:\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Mutation tools
// ---------------------------------------------------------------------------

const createHeartbeatCheck: ToolDef = {
  name: "create_heartbeat_check",
  description:
    "Create a new heartbeat (dead-man's-switch) check for a project. The check expects pings on a schedule; if none arrive within the grace window it alerts. Provide either periodSeconds for a simple fixed period, or a cron schedule + tz for cron-based scheduling — exactly one of the two is required.",
  inputSchema: {
    projectId: z.string().min(1).describe("The project ID to create the check in"),
    name: z.string().describe("Human-readable name for the check"),
    periodSeconds: z
      .number()
      .int()
      .optional()
      .describe(
        "Expected ping interval in seconds. Provide this OR schedule/tz, not both.",
      ),
    schedule: z
      .string()
      .optional()
      .describe(
        "Cron expression (e.g. '0 9 * * *') for cron-based scheduling. Provide this OR periodSeconds, not both. Requires tz.",
      ),
    tz: z
      .string()
      .optional()
      .describe("IANA timezone (e.g. 'America/New_York') for the cron schedule. Required when schedule is set."),
    graceSeconds: z.number().int().describe("Grace period after a missed ping before alerting"),
  },
  handler: async (args, gql) => {
    const projectId = args["projectId"] as string;
    const name = args["name"] as string;
    const periodSeconds = args["periodSeconds"] as number | undefined;
    const schedule = args["schedule"] as string | undefined;
    const tz = args["tz"] as string | undefined;
    const graceSeconds = args["graceSeconds"] as number;

    const data = await gql(
      `mutation createCheck(
        $projectId: ID!
        $name: String!
        $graceSeconds: Int!
        $periodSeconds: Int
        $schedule: String
        $tz: String
      ) {
        createCheck(
          projectId: $projectId
          name: $name
          graceSeconds: $graceSeconds
          periodSeconds: $periodSeconds
          schedule: $schedule
          tz: $tz
        ) {
          id
        }
      }`,
      { projectId, name, graceSeconds, periodSeconds, schedule, tz },
    );

    const { createCheck } = cast<CreateCheckResponse>(data);
    return text(`Heartbeat check created. id: ${createCheck.id}`);
  },
};

const createActiveCheck: ToolDef = {
  name: "create_active_check",
  description:
    "Create a new active (HTTP or TCP) check for a project. The monitoring worker will probe the target on the given interval.",
  inputSchema: {
    projectId: z.string().min(1).describe("The project ID"),
    name: z.string().describe("Human-readable name for the check"),
    type: z.enum(["HTTP", "TCP"]).describe("Check type: HTTP or TCP"),
    target: z.string().describe("URL (HTTP) or host:port (TCP) to probe"),
    intervalSeconds: z.number().int().describe("Probe interval in seconds"),
    timeoutMs: z.number().int().describe("Probe timeout in milliseconds"),
    method: z.string().optional().describe("HTTP method (default GET); ignored for TCP"),
    expectedStatus: z.number().int().optional().describe("Expected HTTP status code (e.g. 200)"),
  },
  handler: async (args, gql) => {
    const projectId = args["projectId"] as string;
    const name = args["name"] as string;
    const type = args["type"] as string;
    const target = args["target"] as string;
    const intervalSeconds = args["intervalSeconds"] as number;
    const timeoutMs = args["timeoutMs"] as number;
    const method = args["method"] as string | undefined;
    const expectedStatus = args["expectedStatus"] as number | undefined;

    const data = await gql(
      `mutation createActiveCheck(
        $projectId: ID!
        $name: String!
        $type: String!
        $target: String!
        $intervalSeconds: Int!
        $timeoutMs: Int!
        $method: String
        $expectedStatus: Int
      ) {
        createActiveCheck(
          projectId: $projectId
          name: $name
          type: $type
          target: $target
          intervalSeconds: $intervalSeconds
          timeoutMs: $timeoutMs
          method: $method
          expectedStatus: $expectedStatus
        ) {
          id
        }
      }`,
      { projectId, name, type, target, intervalSeconds, timeoutMs, method, expectedStatus },
    );

    const { createActiveCheck: result } = cast<CreateActiveCheckResponse>(data);
    return text(`Active check created. id: ${result.id}`);
  },
};

const pauseCheck: ToolDef = {
  name: "pause_check",
  description: "Pause monitoring for a check. No alerts will fire while paused.",
  inputSchema: {
    id: z.string().min(1).describe("The check ID to pause"),
  },
  handler: async (args, gql) => {
    const id = args["id"] as string;

    const data = await gql(
      `mutation pauseCheck($id: ID!) {
        pauseCheck(id: $id) {
          id
          status
        }
      }`,
      { id },
    );

    const { pauseCheck: result } = cast<PauseCheckResponse>(data);
    return text(`Check ${result.id} paused. Status: ${result.status}`);
  },
};

const resumeCheck: ToolDef = {
  name: "resume_check",
  description: "Resume monitoring for a previously paused check.",
  inputSchema: {
    id: z.string().min(1).describe("The check ID to resume"),
  },
  handler: async (args, gql) => {
    const id = args["id"] as string;

    const data = await gql(
      `mutation resumeCheck($id: ID!) {
        resumeCheck(id: $id) {
          id
          status
        }
      }`,
      { id },
    );

    const { resumeCheck: result } = cast<ResumeCheckResponse>(data);
    return text(`Check ${result.id} resumed. Status: ${result.status}`);
  },
};

const setCheckChannelEnabled: ToolDef = {
  name: "set_check_channel_enabled",
  description: "Enable or disable one notification channel for a check.",
  inputSchema: {
    checkId: z.string().min(1).describe("The check ID"),
    channelId: z.string().min(1).describe("The notification channel ID"),
    enabled: z.boolean().describe("Whether the channel should receive check notifications"),
  },
  handler: async (args, gql) => {
    const checkId = args["checkId"] as string;
    const channelId = args["channelId"] as string;
    const enabled = args["enabled"] as boolean;

    const data = await gql(
      `mutation setCheckChannelEnabled($checkId: ID!, $channelId: ID!, $enabled: Boolean!) {
        setCheckChannelEnabled(checkId: $checkId, channelId: $channelId, enabled: $enabled) {
          id
          notificationChannelIds
        }
      }`,
      { checkId, channelId, enabled },
    );

    const { setCheckChannelEnabled: result } =
      cast<SetCheckChannelEnabledResponse>(data);
    const effectiveIds =
      result.notificationChannelIds.length > 0
        ? result.notificationChannelIds.join(", ")
        : "none";
    return text(`Check ${result.id} notification channels: ${effectiveIds}`);
  },
};

const deleteCheck: ToolDef = {
  name: "delete_check",
  description: "Permanently delete a check and all its events. This cannot be undone.",
  inputSchema: {
    id: z.string().min(1).describe("The check ID to delete"),
  },
  handler: async (args, gql) => {
    const id = args["id"] as string;

    await gql(
      `mutation deleteCheck($id: ID!) {
        deleteCheck(id: $id)
      }`,
      { id },
    );

    return text(`Check ${id} deleted.`);
  },
};

const createChannel: ToolDef = {
  name: "create_channel",
  description:
    "Create an EMAIL, SLACK, or WEBHOOK notification channel. Telegram destinations require the interactive SystemVitals managed-bot handshake in the web app; agents cannot bypass destination validation.",
  inputSchema: {
    projectId: z.string().min(1).describe("The project ID"),
    type: z.enum(["EMAIL", "SLACK", "WEBHOOK"]).describe("Channel type"),
    configJson: z
      .string()
      .describe(
        'Channel-specific config as a JSON string, e.g. {"email":"ops@example.com"} for EMAIL',
      ),
  },
  handler: async (args, gql) => {
    const projectId = args["projectId"] as string;
    const type = args["type"] as string;
    const configJson = args["configJson"] as string;

    const data = await gql(
      `mutation createChannel($projectId: ID!, $type: String!, $configJson: String!) {
        createChannel(projectId: $projectId, type: $type, configJson: $configJson) {
          id
          type
          enabled
          verificationStatus
          verificationDeliveryStatus
          verificationExpiresAt
        }
      }`,
      { projectId, type, configJson },
    );

    const { createChannel: result } = cast<CreateChannelResponse>(data);
    if (type === "EMAIL") {
      if (result.verificationDeliveryStatus === "NOT_SENT") {
        return text(
          `Channel created. id: ${result.id}\nStatus: ${result.verificationStatus}\nVerification email was not sent. Use resend_email_channel_verification with channel ID ${result.id} to try again.`,
        );
      }
      return text(
        `Channel created. id: ${result.id}\nStatus: ${result.verificationStatus}\nVerification email sent; alerts remain inactive until the recipient confirms.`,
      );
    }
    return text(`Channel created. id: ${result.id}`);
  },
};

const resendEmailChannelVerification: ToolDef = {
  name: "resend_email_channel_verification",
  description:
    "Resend an email channel's recipient-confirmation message. Requires authenticated access to the channel; it cannot confirm, activate, bypass, or force verification. Requests within the 60-second cooldown return an API error.",
  inputSchema: {
    channelId: z.string().min(1).describe("The pending email channel ID"),
  },
  handler: async (args, gql) => {
    const channelId = args["channelId"] as string;
    const data = await gql(
      `mutation resendEmailChannelVerification($channelId: ID!) {
        resendEmailChannelVerification(channelId: $channelId) {
          id
          type
          enabled
          verificationStatus
          verificationDeliveryStatus
          verificationExpiresAt
        }
      }`,
      { channelId },
    );

    const { resendEmailChannelVerification: result } =
      cast<ResendEmailChannelVerificationResponse>(data);
    if (result.verificationDeliveryStatus === "NOT_SENT") {
      return text(
        `Verification email was not sent. Channel ${result.id} remains ${result.verificationStatus}; try again when email delivery is available.`,
      );
    }
    return text(
      `Verification email resent. Channel ${result.id} remains ${result.verificationStatus} until the recipient confirms.`,
    );
  },
};

const deleteChannel: ToolDef = {
  name: "delete_channel",
  description:
    "Permanently delete a notification channel, including an already-connected Telegram row. This cannot be undone.",
  inputSchema: {
    id: z.string().min(1).describe("The channel ID to delete"),
  },
  handler: async (args, gql) => {
    const id = args["id"] as string;

    await gql(
      `mutation deleteChannel($id: ID!) {
        deleteChannel(id: $id)
      }`,
      { id },
    );

    return text(`Channel ${id} deleted.`);
  },
};

const regeneratePingKey: ToolDef = {
  name: "regenerate_ping_key",
  description:
    "Regenerate the ping key for a project. The old key is immediately invalidated.",
  inputSchema: {
    projectId: z.string().min(1).describe("The project ID whose ping key to regenerate"),
  },
  handler: async (args, gql) => {
    const projectId = args["projectId"] as string;

    const data = await gql(
      `mutation regeneratePingKey($projectId: ID!) {
        regeneratePingKey(projectId: $projectId) {
          id
          pingKey
        }
      }`,
      { projectId },
    );

    const { regeneratePingKey: result } = cast<RegeneratePingKeyResponse>(data);
    return text(`Ping key regenerated for project ${result.id}. New pingKey: ${result.pingKey}`);
  },
};

// Keys of UpdateCheckInput, in the order they're selected back from the mutation.
const UPDATE_CHECK_INPUT_KEYS = [
  "name",
  "slug",
  "type",
  "periodSeconds",
  "graceSeconds",
  "schedule",
  "tz",
  "target",
  "method",
  "expectedStatus",
  "intervalSeconds",
  "timeoutMs",
] as const;

const updateCheck: ToolDef = {
  name: "update_check",
  description:
    "Update mutable fields on an existing check. Only the fields you supply are changed — everything else is left as-is. A heartbeat check is timed by either periodSeconds or schedule+tz, never both. Active (HTTP/TCP) checks use target, intervalSeconds, and timeoutMs; HTTP also has method and expectedStatus. id, projectId, pingSlug, and status cannot be changed here.",
  inputSchema: {
    id: z.string().min(1).describe("The check ID to update"),
    name: z.string().optional().describe("New display name"),
    slug: z
      .string()
      .optional()
      .describe(
        "URL slug, unique within the project. Changing it changes the check's URL and the old one stops working.",
      ),
    type: z
      .enum(["HEARTBEAT", "HTTP", "TCP"])
      .optional()
      .describe(
        "Convert the check to this type. PING is not supported — it has no prober.",
      ),
    periodSeconds: z
      .number()
      .int()
      .optional()
      .describe("Heartbeat: expected seconds between pings"),
    graceSeconds: z
      .number()
      .int()
      .optional()
      .describe("Heartbeat: grace period before going down"),
    schedule: z
      .string()
      .optional()
      .describe("Heartbeat: cron expression, instead of periodSeconds"),
    tz: z
      .string()
      .optional()
      .describe("Heartbeat: IANA timezone for the cron schedule"),
    target: z
      .string()
      .optional()
      .describe("Active: URL for HTTP, host:port for TCP"),
    method: z.string().optional().describe("HTTP: request method, defaults to GET"),
    expectedStatus: z
      .number()
      .int()
      .optional()
      .describe("HTTP: expected response status"),
    intervalSeconds: z
      .number()
      .int()
      .optional()
      .describe("Active: seconds between probes"),
    timeoutMs: z
      .number()
      .int()
      .optional()
      .describe("Active: probe timeout in milliseconds"),
  },
  handler: async (args, gql) => {
    const id = args["id"] as string;

    // Copy only the keys the caller actually supplied — an absent key means
    // "leave unchanged" server-side, so we never send an explicit null.
    const input: Record<string, unknown> = {};
    for (const key of UPDATE_CHECK_INPUT_KEYS) {
      if (args[key] !== undefined) {
        input[key] = args[key];
      }
    }

    const data = await gql(
      `mutation updateCheck($id: ID!, $input: UpdateCheckInput!) {
        updateCheck(id: $id, input: $input) {
          id
          name
          slug
          type
          periodSeconds
          graceSeconds
          schedule
          tz
          target
          method
          expectedStatus
          intervalSeconds
          timeoutMs
        }
      }`,
      { id, input },
    );

    const { updateCheck: result } = cast<UpdateCheckResponse>(data);
    const parts = [`Check ${result.id} updated.`, `Name: ${result.name}`, `Type: ${result.type}`];
    if (result.periodSeconds != null) parts.push(`Period: ${result.periodSeconds}s`);
    if (result.graceSeconds != null) parts.push(`Grace: ${result.graceSeconds}s`);
    if (result.schedule) {
      parts.push(`Schedule: ${result.schedule} (${result.tz ?? "UTC"})`);
    }
    if (result.target) parts.push(`Target: ${result.target}`);
    if (result.method) parts.push(`Method: ${result.method}`);
    if (result.expectedStatus != null) {
      parts.push(`Expected status: ${result.expectedStatus}`);
    }
    if (result.intervalSeconds != null) parts.push(`Interval: ${result.intervalSeconds}s`);
    if (result.timeoutMs != null) parts.push(`Timeout: ${result.timeoutMs}ms`);

    return text(parts.join(" "));
  },
};

// ---------------------------------------------------------------------------
// Member tools
// ---------------------------------------------------------------------------

const listMembers: ToolDef = {
  name: "list_members",
  description:
    "List the members of an organization, with their membership id and role. Available on every plan.",
  inputSchema: {
    organizationId: z.string().min(1).describe("Organization id"),
  },
  handler: async (args, gql) => {
    const organizationId = args["organizationId"] as string;
    const data = await gql(
      `query organizationMembers($organizationId: ID!) {
        organizationMembers(organizationId: $organizationId) { id email role }
      }`,
      { organizationId },
    );
    const { organizationMembers } = cast<ListMembersResponse>(data);
    if (organizationMembers.length === 0) return text("No members found.");
    return text(
      organizationMembers
        .map((m) => `${m.email} — ${m.role} (membership ${m.id})`)
        .join("\n"),
    );
  },
};

const inviteMember: ToolDef = {
  name: "invite_member",
  description:
    "Invite someone to an organization by email without exposing the acceptance secret. Requires owner or admin.",
  inputSchema: {
    organizationId: z.string().min(1).describe("Organization id"),
    email: z.string().describe("Email address to invite"),
    role: z
      .enum(["MEMBER", "ADMIN"])
      .optional()
      .describe("Role to grant on acceptance. Defaults to MEMBER."),
  },
  handler: async (args, gql) => {
    const organizationId = args["organizationId"] as string;
    const email = args["email"] as string;
    const role = (args["role"] as string | undefined) ?? "MEMBER";

    const data = await gql(
      `mutation inviteMember($organizationId: ID!, $email: String!, $role: String!) {
        inviteMember(organizationId: $organizationId, email: $email, role: $role) {
          id email role
        }
      }`,
      { organizationId, email, role },
    );
    const { inviteMember: invite } = cast<InviteMemberResponse>(data);
    return text(`Invited ${invite.email} as ${invite.role}.`);
  },
};

const revokeInvite: ToolDef = {
  name: "revoke_invite",
  description: "Revoke a pending organization invite. Requires owner or admin.",
  inputSchema: {
    inviteId: z.string().min(1).describe("Invite id"),
  },
  handler: async (args, gql) => {
    const inviteId = args["inviteId"] as string;
    await gql(
      `mutation revokeInvite($inviteId: ID!) { revokeInvite(inviteId: $inviteId) }`,
      { inviteId },
    );
    return text(`Invite ${inviteId} revoked.`);
  },
};

const updateMemberRole: ToolDef = {
  name: "update_member_role",
  description:
    "Change a member's role. Requires owner. An organization must always keep at least one owner.",
  inputSchema: {
    membershipId: z.string().min(1).describe("Membership id (from list_members)"),
    role: z.enum(["OWNER", "ADMIN", "MEMBER"]).describe("New role"),
  },
  handler: async (args, gql) => {
    const membershipId = args["membershipId"] as string;
    const role = args["role"] as string;
    const data = await gql(
      `mutation updateMemberRole($membershipId: ID!, $role: String!) {
        updateMemberRole(membershipId: $membershipId, role: $role) { id role }
      }`,
      { membershipId, role },
    );
    const { updateMemberRole: result } = cast<UpdateMemberRoleResponse>(data);
    return text(`Membership ${result.id} is now ${result.role}.`);
  },
};

const removeMember: ToolDef = {
  name: "remove_member",
  description:
    "Remove a member from an organization. Owners and admins may call this; admins may only remove plain members.",
  inputSchema: {
    membershipId: z.string().min(1).describe("Membership id (from list_members)"),
  },
  handler: async (args, gql) => {
    const membershipId = args["membershipId"] as string;
    await gql(
      `mutation removeMember($membershipId: ID!) { removeMember(membershipId: $membershipId) }`,
      { membershipId },
    );
    return text(`Membership ${membershipId} removed.`);
  },
};

// ---------------------------------------------------------------------------
// Organization tools
// ---------------------------------------------------------------------------

const createOrganization: ToolDef = {
  name: "create_organization",
  description:
    "Create a new organization (team). The caller becomes its owner, and the organization inherits the creator account's effective plan and shared quota. Subject to the account's organization capacity.",
  inputSchema: {
    name: z.string().describe("Human-readable organization name"),
  },
  handler: async (args, gql) => {
    const name = args["name"] as string;
    const data = await gql(
      `mutation createOrganization($name: String!) {
        createOrganization(name: $name) {
          id
          name
          slug
          role
          plan
          creatorUserId
          creatorLabel
        }
      }`,
      { name },
    );
    const { createOrganization: org } = cast<CreateOrganizationResponse>(data);
    return text(
      `Organization "${org.name}" created — id ${org.id}, slug ${org.slug}; ${org.plan} plan inherited from ${org.creatorLabel} (${org.creatorUserId}).`,
    );
  },
};

const updateOrganization: ToolDef = {
  name: "update_organization",
  description:
    "Update an organization's display name and/or URL slug; at least one of name or slug is required. Requires owner or admin.",
  inputSchema: {
    organizationId: z.string().min(1).describe("Organization id"),
    name: z.string().min(1).optional().describe("New display name"),
    slug: z.string().min(1).optional().describe("New URL slug"),
  },
  handler: async (args, gql) => {
    const organizationId = args["organizationId"] as string;
    const name = args["name"] as string | undefined;
    const slug = args["slug"] as string | undefined;
    if (name === undefined && slug === undefined) {
      throw new Error("At least one of name or slug must be supplied.");
    }

    const variables: Record<string, unknown> = { organizationId };
    if (name !== undefined) variables["name"] = name;
    if (slug !== undefined) variables["slug"] = slug;
    const data = await gql(
      `mutation updateOrganization($organizationId: ID!, $name: String, $slug: String) {
        updateOrganization(organizationId: $organizationId, name: $name, slug: $slug) {
          id
          name
          slug
          plan
          creatorUserId
          creatorLabel
        }
      }`,
      variables,
    );
    const { updateOrganization: org } =
      cast<UpdateOrganizationResponse>(data);
    return text(
      `Organization "${org.name}" updated — id ${org.id}, slug ${org.slug}; ${org.plan} plan inherited from ${org.creatorLabel} (${org.creatorUserId}).`,
    );
  },
};

const transferOrganizationCreatorship: ToolDef = {
  name: "transfer_organization_creatorship",
  description:
    "Transfer organization creatorship to a recipient who must already be an owner. Plan and shared-quota attribution move to the recipient account. The transfer is rejected if that account lacks organization or check capacity.",
  inputSchema: {
    organizationId: z.string().min(1).describe("Organization id"),
    newCreatorUserId: z.string().min(1).describe("New creator user id"),
  },
  handler: async (args, gql) => {
    const variables = args as {
      organizationId: string;
      newCreatorUserId: string;
    };
    const data = await gql(
      `mutation transferOrganizationCreatorship(
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
    );
    const { transferOrganizationCreatorship: org } =
      cast<TransferOrganizationCreatorshipResponse>(data);
    return text(
      `Organization "${org.name}" creatorship transferred to ${org.creatorLabel} (${org.creatorUserId}); ${org.plan} plan inherited from the new creator account.`,
    );
  },
};

const leaveOrganization: ToolDef = {
  name: "leave_organization",
  description:
    "Leave an organization. The last owner cannot leave until another owner is assigned.",
  inputSchema: {
    organizationId: z.string().min(1).describe("Organization id"),
  },
  handler: async (args, gql) => {
    const organizationId = args["organizationId"] as string;
    await gql(
      `mutation leaveOrganization($organizationId: ID!) {
        leaveOrganization(organizationId: $organizationId)
      }`,
      { organizationId },
    );
    return text(`Organization ${organizationId} left.`);
  },
};

const deleteOrganization: ToolDef = {
  name: "delete_organization",
  description:
    "Delete an organization and everything in it (projects, checks, members, invites). Requires owner. Cannot delete your last organization.",
  inputSchema: {
    organizationId: z.string().min(1).describe("Organization id"),
  },
  handler: async (args, gql) => {
    const organizationId = args["organizationId"] as string;
    await gql(
      `mutation deleteOrganization($organizationId: ID!) {
        deleteOrganization(organizationId: $organizationId)
      }`,
      { organizationId },
    );
    return text(`Organization ${organizationId} deleted.`);
  },
};

const toolDefinitions: ToolDef[] = [
  listProjects,
  listChecks,
  getCheck,
  listChannels,
  createHeartbeatCheck,
  createActiveCheck,
  pauseCheck,
  resumeCheck,
  deleteCheck,
  setCheckChannelEnabled,
  createChannel,
  resendEmailChannelVerification,
  deleteChannel,
  regeneratePingKey,
  updateCheck,
  listMembers,
  inviteMember,
  revokeInvite,
  updateMemberRole,
  removeMember,
  createOrganization,
  updateOrganization,
  transferOrganizationCreatorship,
  leaveOrganization,
  deleteOrganization,
];

function sanitizeError(error: unknown): Error {
  return normalizeGqlError(error);
}

export const tools: ToolDef[] = toolDefinitions.map((definition) => ({
  ...definition,
  handler: async (args, gql) => {
    try {
      return await definition.handler(args, gql);
    } catch (error) {
      throw sanitizeError(error);
    }
  },
}));
