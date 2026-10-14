import { z } from "zod";
import type { ToolDef } from "./tools.js";

// These operations are registered only for explicitly account-wide credentials.
// Existing services enforce current membership, roles, quotas and handshakes.
function accountTool(
  name: string,
  description: string,
  inputSchema: z.ZodRawShape,
  query: string,
  field: string,
): ToolDef {
  return {
    name,
    description,
    inputSchema,
    async handler(args, gql) {
      const variables = z.object(inputSchema).parse(args);
      const data = await gql(query, variables);
      return { content: [{ type: "text", text: JSON.stringify(data[field]) }] };
    },
  };
}

const id = () => z.string().min(1);
const organization = {
  organizationId: id().describe("Organization workspace ID"),
};
const pageFields = "id organizationId slug title checkIds branding";

export const accountTools: readonly ToolDef[] = [
  accountTool(
    "get_account",
    "Get the account identity and all currently accessible organization workspaces.",
    {},
    `query { me { id email hasPassword googleLinked organizations { id name slug role plan pingKey } } }`,
    "me",
  ),
  accountTool(
    "get_subscription",
    "Get the account subscription, plan and aggregate organization/check usage.",
    {},
    `query { mySubscription { plan status maxChecks checkCount organizationCount } }`,
    "mySubscription",
  ),
  accountTool(
    "get_organization_check_allowance",
    "Get the organization creator account's shared check allowance, without creator identity.",
    organization,
    `query($organizationId:ID!){ organizationCheckAllowance(organizationId:$organizationId){used limit remaining} }`,
    "organizationCheckAllowance",
  ),
  accountTool(
    "move_check",
    "Move a check to another organization workspace you can access. Existing per-check channel exclusions are reset.",
    { checkId: id(), destinationOrganizationId: id() },
    `mutation($checkId:ID!,$destinationOrganizationId:ID!){moveCheck(checkId:$checkId,destinationOrganizationId:$destinationOrganizationId){id organizationId name}}`,
    "moveCheck",
  ),
  accountTool(
    "list_status_pages",
    "List public status-page configurations in an organization workspace.",
    organization,
    `query($organizationId:ID!){statusPages(organizationId:$organizationId){${pageFields}}}`,
    "statusPages",
  ),
  accountTool(
    "create_status_page",
    "Create a public status page using checks from the same organization.",
    {
      ...organization,
      slug: z.string().min(1),
      title: z.string().min(1),
      checkIds: z.array(id()),
      brandingJson: z.string().optional(),
    },
    `mutation($organizationId:ID!,$slug:String!,$title:String!,$checkIds:[ID!]!,$brandingJson:String){createStatusPage(organizationId:$organizationId,slug:$slug,title:$title,checkIds:$checkIds,brandingJson:$brandingJson){${pageFields}}}`,
    "createStatusPage",
  ),
  accountTool(
    "update_status_page",
    "Update a public status page's title, selected checks or branding.",
    {
      id: id(),
      title: z.string().optional(),
      checkIds: z.array(id()).optional(),
      brandingJson: z.string().optional(),
    },
    `mutation($id:ID!,$title:String,$checkIds:[ID!],$brandingJson:String){updateStatusPage(id:$id,title:$title,checkIds:$checkIds,brandingJson:$brandingJson){${pageFields}}}`,
    "updateStatusPage",
  ),
  accountTool(
    "delete_status_page",
    "Permanently delete a public status page.",
    { id: id() },
    `mutation($id:ID!){deleteStatusPage(id:$id)}`,
    "deleteStatusPage",
  ),
  accountTool(
    "list_invites",
    "List pending organization invitations. Acceptance secrets are omitted.",
    organization,
    `query($organizationId:ID!){organizationInvites(organizationId:$organizationId){id email role expiresAt}}`,
    "organizationInvites",
  ),
  accountTool(
    "preview_invite",
    "Inspect an invitation using its acceptance token before accepting it.",
    { token: id() },
    `query($token:String!){invitePreview(token:$token){maskedEmail organizationName status}}`,
    "invitePreview",
  ),
  accountTool(
    "accept_invite",
    "Accept an organization invitation for this account using the supplied invitation token.",
    { token: id() },
    `mutation($token:String!){acceptInvite(token:$token){id userId email role}}`,
    "acceptInvite",
  ),
  accountTool(
    "get_telegram_bot",
    "Get the managed Telegram bot username and availability to begin the normal Telegram handshake.",
    {},
    `query{managedTelegramBot{available username}}`,
    "managedTelegramBot",
  ),
  accountTool(
    "preview_telegram_connection",
    "Inspect a Telegram handshake token obtained through the managed bot.",
    { token: id() },
    `query($token:String!){telegramConnectionPreview(token:$token){chatId chatType chatTitle messageThreadId expiresAt}}`,
    "telegramConnectionPreview",
  ),
  accountTool(
    "connect_telegram_channel",
    "Connect Telegram to an organization using a valid managed-bot handshake token. Does not bypass Telegram verification.",
    { ...organization, token: id() },
    `mutation($organizationId:ID!,$token:String!){connectTelegramChannel(organizationId:$organizationId,token:$token){id type enabled organizationId}}`,
    "connectTelegramChannel",
  ),
  accountTool(
    "create_billing_checkout",
    "Create a hosted Stripe checkout link for SIGNAL or FLEET. The user must open the returned URL and complete checkout.",
    {
      plan: z.enum(["SIGNAL", "FLEET"]),
      interval: z.enum(["month", "year"]).optional(),
    },
    `mutation($plan:String!,$interval:String){createBillingCheckout(plan:$plan,interval:$interval){url}}`,
    "createBillingCheckout",
  ),
  accountTool(
    "create_billing_portal",
    "Create a hosted billing portal link for this account. The user opens the URL to manage payment methods or their subscription.",
    {},
    `mutation{createBillingPortal{url}}`,
    "createBillingPortal",
  ),
];
