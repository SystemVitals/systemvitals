import { gql } from "@apollo/client";

/**
 * Deprecated authenticated-route lookup retained until the legacy
 * /[org]/[project]/[check] route becomes a canonical redirect.
 */
export const CHECK_BY_SLUG = gql`
  query CheckBySlug(
    $orgSlug: String!
    $projectSlug: String!
    $checkSlug: String!
  ) {
    checkBySlug(
      orgSlug: $orgSlug
      projectSlug: $projectSlug
      checkSlug: $checkSlug
    ) {
      id
      organizationId
      projectId
      notificationChannelIds
      name
      slug
      type
      status
      pingSlug
      periodSeconds
      graceSeconds
      schedule
      tz
      nextExpectedAt
      target
      method
      expectedStatus
      intervalSeconds
      timeoutMs
      events {
        id
        status
        timestamp
        error
        responseTimeMs
        statusCode
      }
    }
  }
`;
