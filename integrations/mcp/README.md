# SystemVitals MCP Server

Drive [SystemVitals](../../README.md) from Claude Code or any MCP-compatible
client. Session and legacy broad credentials expose the 25 tools listed below;
project-scoped connections expose only their authorized check tools.

> **This package is prepared for public publication, but is not currently
> published.** Publish `@systemvitals/mcp` before deploying frontend setup that
> uses `npx -y @systemvitals/mcp`. Do not reverse that rollout order.

---

## Prerequisites

- Node.js 22+
- A running SystemVitals API (default: `http://localhost:8888/graphql`)
- A SystemVitals agent connection secret (`svt_...`) — open a project and
  choose **Connect agent**. Existing connections and revocation history live
  under **Account > Agent connections**.

---

## Environment variables

| Variable | Description | Example |
|---|---|---|
| `SYSTEMVITALS_API_URL` | GraphQL endpoint of your SystemVitals API | `http://localhost:8888/graphql` |
| `SYSTEMVITALS_API_TOKEN` | Bearer API token | `svt_abc123` |

Both are required. The server exits with a clear error if either is missing.

---

## Registering in Claude Code

After the package has been published, the Connect agent wizard generates setup
for Claude Code, Codex, Cursor, Universal JSON, and GraphQL/cURL. Claude Code
setup prompts for the token so the literal secret is not written into shell
history:

```bash
read -rsp 'SystemVitals API token: ' SYSTEMVITALS_API_TOKEN
printf '\n'
claude mcp add systemvitals \
  --env SYSTEMVITALS_API_URL=http://localhost:8888/graphql \
  --env "SYSTEMVITALS_API_TOKEN=$SYSTEMVITALS_API_TOKEN" \
  -- npx -y @systemvitals/mcp
unset SYSTEMVITALS_API_TOKEN
```

Claude Code will start the MCP server automatically when needed. The command
avoids the shell-history leak, but the Claude CLI persists the bearer
credential in its MCP configuration.

### Alternative: MCP config file

If you prefer a config file, add to your MCP configuration (e.g.
`.claude/mcp.json`):

```json
{
  "mcpServers": {
    "systemvitals": {
      "command": "npx",
      "args": ["-y", "@systemvitals/mcp"],
      "env": {
        "SYSTEMVITALS_API_URL": "http://localhost:8888/graphql",
        "SYSTEMVITALS_API_TOKEN": "svt_xxx"
      }
    }
  }
}
```

Codex, Cursor, Claude, and universal MCP configuration files contain the bearer
secret. Keep them in a private, user-only location and use user-only file
permissions, never commit them, and revoke the connection when it is no longer
needed.

---

## Credential-dependent tools

The server introspects the credential before registering tools:

- Session JWTs and legacy broad `read`/`write` tokens retain all **25** tools
  below for compatibility.
- A full project-scoped agent connection exposes **8** check tools: two reads
  and six mutations.
- A read-only scoped credential exposes only **2** tools: `list_checks` and
  `get_check`.

For scoped credentials, the server injects the bound project and no tool schema
exposes a project selector. Startup fails for a malformed unbound scoped
credential instead of silently widening access.

## Legacy/session tool catalog (25 total)

### Read tools (5)

| Tool | Description |
|---|---|
| `list_projects` | List all organizations and projects accessible with the current API token |
| `list_checks` | List all checks for a given project (with status, interval, last event) |
| `get_check` | Get full details and recent events for a specific check |
| `list_channels` | List notification channels for a given project, including already-connected Telegram rows |
| `list_members` | List the members of an organization, with membership id and role |

### Write/mutation tools (20)

| Tool | Description |
|---|---|
| `create_project` | Create a new project inside an organization |
| `regenerate_ping_key` | Regenerate the ping key for a project (old key immediately invalidated) |
| `create_heartbeat_check` | Create a heartbeat (dead-man's-switch) check — alerts if pings stop arriving. Provide either `periodSeconds` for a simple period, or `schedule` + `tz` for a cron schedule |
| `create_active_check` | Create an active HTTP or TCP probe check |
| `update_check` | Update mutable fields on an existing check (name, period, grace) |
| `pause_check` | Pause monitoring for a check (no alerts while paused) |
| `resume_check` | Resume a previously paused check |
| `delete_check` | Permanently delete a check and all its events |
| `create_channel` | Create an EMAIL, SLACK, or WEBHOOK channel; email remains pending until recipient confirmation, while Telegram requires the web-app handshake |
| `resend_email_channel_verification` | Resend verification for a pending email channel by channel ID; reports delivery failure and API cooldown/errors |
| `delete_channel` | Permanently delete a notification channel, including an already-connected Telegram row |
| `invite_member` | Invite someone to an organization by email without exposing the acceptance secret (owner/admin only) |
| `revoke_invite` | Revoke a pending organization invite (owner/admin only) |
| `update_member_role` | Change a member's role; an org must always keep at least one owner (owner only) |
| `remove_member` | Remove a member from an organization (owner/admin, admins may only remove plain members) |
| `create_organization` | Create an organization inheriting your account plan and become its owner |
| `update_organization` | Atomically update an organization's display name and/or URL slug; at least one is required (owner/admin only) |
| `transfer_organization_creatorship` | Transfer creatorship to an existing owner; rejected if their account lacks organization or check capacity |
| `leave_organization` | Leave an organization, subject to the last-owner guard |
| `delete_organization` | Permanently delete an owned, non-last organization |

Team membership (`list_members`, `invite_member`, `revoke_invite`,
`update_member_role`, `remove_member`) is available on every plan — it is not
a paid-tier feature. Organization plan values shown by MCP tools are inherited
from the creator's account. Transferring creatorship changes that attribution;
the recipient must already be an owner and have enough account-wide
organization and check capacity. SOLO accounts may create 10 organizations;
SIGNAL and FLEET organization counts are unlimited. Check quotas are shared
across all organizations attributed to one creator account. The previous
creator remains an owner after transfer, and deleting an organization never
changes account billing.

> **Not exposed:** escalation-policy list/create/update/delete, status-page
> list/create/update/delete, and check acknowledgement are currently absent
> from MCP even though those management surfaces exist in the API/frontend.
> API-token administration (creation, listing/history, and revocation) requires
> a session JWT and cannot be called with an ApiToken. Account password
> management, account billing, checkout, portal, and Stripe actions also remain
> outside MCP.

Email create/list results include `verificationStatus`,
`verificationDeliveryStatus`, and `verificationExpiresAt`. Pending channels
are inactive; `NOT_SENT` output directs callers to resend. MCP exposes no
verify, confirm, activate, bypass, or force operation. Confirmation remains the
recipient's emailed link plus an explicit public-page button press. Links
expire after 24 hours and resend has a 60-second cooldown.

Agent secrets are shown once at creation. They must never be logged, persisted
by SystemVitals, placed in URLs, or sent to analytics. Revoke an exposed
connection from **Account > Agent connections**.

## Credential errors

MCP credential and project-policy errors identify the recovery action without
echoing bearer secrets or inaccessible project details:

| Error | Action |
|---|---|
| Credential expired or revoked | Create a new agent connection and update `SYSTEMVITALS_API_TOKEN` |
| Credential owner account suspended | Ask an administrator to restore the account before reconnecting |
| Bound project deleted | Connect the agent to an existing project |
| Bound project access removed | Restore the owner's project membership or create a new connection |
| Missing `checks:read` or `checks:write` | Create a connection with the named capability |
| Credential bound to another project | Use the bound project or connect with a credential for the requested project |
| Credential rejected for another reason | Verify `SYSTEMVITALS_API_TOKEN` or create a new connection |

---

## Running from a source checkout

```bash
cp .env.example .env
# edit .env with your values
npx tsx cli/mcp.ts
```

Or load the values into the environment and run:

```bash
npm start
```

---

## Development

See [CLAUDE.md](./CLAUDE.md) for architecture notes, test patterns, and extension guidance.
