/**
 * Minimal GraphQL client for the SystemVitals API.
 * Sends bearer-token authenticated POST requests to the GraphQL endpoint.
 *
 * IMPORTANT: This module NEVER imports @systemvitals/database or touches the DB.
 */

export type Gql = (
  query: string,
  variables?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export function normalizeGqlError(error: unknown): Error {
  const message = error instanceof Error ? error.message : "";

  if (/\bcredential (?:has )?expired\b/i.test(message)) {
    return new Error(
      "SystemVitals credential has expired. Create a new agent connection and update SYSTEMVITALS_API_TOKEN.",
    );
  }
  if (/\bcredential (?:was |has been )?revoked\b/i.test(message)) {
    return new Error(
      "SystemVitals credential was revoked. Create a new agent connection and update SYSTEMVITALS_API_TOKEN.",
    );
  }
  if (
    /credential owner account suspended|account.*credential.*suspended/i.test(
      message,
    )
  ) {
    return new Error(
      "The account that owns this SystemVitals credential is suspended. Ask an administrator to restore the account before reconnecting.",
    );
  }
  if (
    /credential project no longer exists|project.*credential.*no longer exists|project (?:was )?deleted/i.test(
      message,
    )
  ) {
    return new Error(
      "The project bound to this SystemVitals credential no longer exists. Connect the agent to an existing project.",
    );
  }
  if (
    /credential project is no longer accessible|access to the project bound to this systemvitals credential was removed|not a member|project not found|no longer.*access|lost access/i.test(
      message,
    )
  ) {
    return new Error(
      "Access to the project bound to this SystemVitals credential was removed. Restore the owner's project membership or create a new agent connection.",
    );
  }

  const missingCapability = message.match(
    /(?:missing(?: required)? capability:\s*|credential is missing\s+)(checks:(?:read|write))/i,
  )?.[1];
  if (missingCapability) {
    const capability = missingCapability.toLowerCase();
    return new Error(
      `This SystemVitals credential is missing ${capability}. Create a connection with the ${capability} capability.`,
    );
  }
  if (/missing.*capabil|capabilit.*required|insufficient.*scope/i.test(message)) {
    return new Error(
      "This SystemVitals credential is missing a required capability. Create a connection with the required access.",
    );
  }
  if (
    /credential is bound to a different project|different project|wrong project|project scope|scoped to/i.test(
      message,
    )
  ) {
    return new Error(
      "This SystemVitals credential is bound to a different project. Use the bound project or connect with a credential for the requested project.",
    );
  }
  if (/unauthorized|unauthenticated/i.test(message)) {
    return new Error(
      "SystemVitals rejected this credential. Verify SYSTEMVITALS_API_TOKEN or create a new agent connection.",
    );
  }
  if (/check limit|shared.*quota|quota.*reached|maximum.*checks/i.test(message)) {
    return new Error("The account's shared check quota has been reached.");
  }
  if (/forbidden/i.test(message)) {
    return new Error("This credential cannot perform that project operation.");
  }

  const withoutTokens = message
    .replace(/\bsvt_[A-Za-z0-9._~-]+\b/g, "[redacted]")
    .replace(/https?:\/\/\S*\/invite\/\S+/gi, "[redacted]");
  return new Error(withoutTokens || "SystemVitals API request failed.");
}

/**
 * Create a Gql function bound to the given API URL and bearer token.
 */
export function makeGql(apiUrl: string, token: string): Gql {
  return async (query: string, variables?: Record<string, unknown>) => {
    try {
      const res = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!res.ok) {
        if (res.status === 401) {
          throw new Error("Unauthorized");
        }
        throw new Error(
          `GraphQL request failed: HTTP ${res.status} ${res.statusText}`,
        );
      }

      const json = (await res.json()) as {
        data?: Record<string, unknown>;
        errors?: { message: string }[];
      };

      if (json.errors && json.errors.length > 0) {
        throw new Error(json.errors[0].message);
      }

      return json.data ?? {};
    } catch (error) {
      throw normalizeGqlError(error);
    }
  };
}
