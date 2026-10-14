import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { buildSchema, parse, validate } from "graphql";
import { toolsForCredential, type Credential } from "../src/credential.js";
import type { Gql } from "../src/gql.js";
import { tools } from "../src/tools.js";

const credential: Credential = {
  authKind: "api-token",
  credentialMode: "ACCOUNT",
  capabilities: ["account:manage", "checks:read", "checks:write"],
  organizationId: null,
  organizationName: null,
  projectId: null,
  projectName: null,
};
const cases = [
  { name: "get_account", args: {}, field: "me" },
  { name: "get_subscription", args: {}, field: "mySubscription" },
  {
    name: "get_organization_check_allowance",
    args: { organizationId: "org1" },
    field: "organizationCheckAllowance",
  },
  {
    name: "move_check",
    args: { checkId: "check1", destinationOrganizationId: "org2" },
    field: "moveCheck",
  },
  {
    name: "list_status_pages",
    args: { organizationId: "org1" },
    field: "statusPages",
  },
  {
    name: "create_status_page",
    args: {
      organizationId: "org1",
      slug: "public-status",
      title: "Status",
      checkIds: ["check1"],
    },
    field: "createStatusPage",
  },
  {
    name: "update_status_page",
    args: { id: "page1", title: "Updated" },
    field: "updateStatusPage",
  },
  {
    name: "delete_status_page",
    args: { id: "page1" },
    field: "deleteStatusPage",
  },
  {
    name: "list_invites",
    args: { organizationId: "org1" },
    field: "organizationInvites",
  },
  {
    name: "preview_invite",
    args: { token: "invitation" },
    field: "invitePreview",
  },
  {
    name: "accept_invite",
    args: { token: "invitation" },
    field: "acceptInvite",
  },
  { name: "get_telegram_bot", args: {}, field: "managedTelegramBot" },
  {
    name: "preview_telegram_connection",
    args: { token: "handshake" },
    field: "telegramConnectionPreview",
  },
  {
    name: "connect_telegram_channel",
    args: { organizationId: "org1", token: "handshake" },
    field: "connectTelegramChannel",
  },
  {
    name: "create_billing_checkout",
    args: { plan: "SIGNAL", interval: "year" },
    field: "createBillingCheckout",
  },
  { name: "create_billing_portal", args: {}, field: "createBillingPortal" },
];

describe("account credential tools", () => {
  it("includes broad product tools and the account catalog only for ACCOUNT", () => {
    const accountTools = toolsForCredential(credential);
    const names = accountTools.map((tool) => tool.name);
    expect(names).toEqual([
      ...tools.map((tool) => tool.name),
      ...cases.map((test) => test.name),
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(
      names.some((name) =>
        /password|api_token|personal_access_token|admin/.test(name),
      ),
    ).toBe(false);
    for (const mode of ["SESSION", "LEGACY_BROAD"] as const) {
      expect(toolsForCredential({ ...credential, credentialMode: mode })).toBe(
        tools,
      );
    }
  });
  it.each(cases)(
    "$name sends a valid GraphQL operation and only its declared variables",
    async ({ name, args, field }) => {
      const tool = toolsForCredential(credential).find(
        (tool) => tool.name === name,
      )!;
      const gql = vi
        .fn<Gql>()
        .mockResolvedValue({
          [field]: { id: "result1", url: "https://billing.example.test" },
        });
      const result = await tool.handler(args, gql);
      const [query, variables] = gql.mock.calls[0];
      const schema = buildSchema(
        readFileSync(
          new URL("../../../api/src/schema.gql", import.meta.url),
          "utf8",
        ),
      );
      expect(validate(schema, parse(query))).toEqual([]);
      expect(query).toContain(field);
      expect(variables).toEqual(args);
      expect(result.content[0].text).toContain("result1");
    },
  );
  it("propagates API authorization errors instead of reporting success", async () => {
    const tool = toolsForCredential(credential).find(
      (tool) => tool.name === "delete_status_page",
    )!;
    const gql = vi
      .fn<Gql>()
      .mockRejectedValue(new Error("Not a member of this organization"));
    await expect(tool.handler({ id: "page1" }, gql)).rejects.toThrow(
      "Not a member",
    );
  });
});
