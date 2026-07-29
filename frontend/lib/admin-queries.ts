import { gql } from "@apollo/client";

export const ADMIN_USERS = gql`
  query adminUsers($search: String, $page: Int, $pageSize: Int) {
    adminUsers(search: $search, page: $page, pageSize: $pageSize) {
      items {
        id
        email
        isAdmin
        suspendedAt
        createdAt
        organizations {
          id
          name
          role
        }
      }
      total
    }
  }
`;

export const ADMIN_USER = gql`
  query adminUser($id: ID!) {
    adminUser(id: $id) {
      id
      email
      isAdmin
      suspendedAt
      createdAt
      organizations {
        id
        name
        role
      }
    }
  }
`;

export const ADMIN_SUSPEND_USER = gql`
  mutation adminSuspendUser($id: ID!) {
    adminSuspendUser(id: $id) {
      id
      email
      isAdmin
      suspendedAt
      createdAt
      organizations {
        id
        name
        role
      }
    }
  }
`;

export const ADMIN_UNSUSPEND_USER = gql`
  mutation adminUnsuspendUser($id: ID!) {
    adminUnsuspendUser(id: $id) {
      id
      email
      isAdmin
      suspendedAt
      createdAt
      organizations {
        id
        name
        role
      }
    }
  }
`;

export const ADMIN_SET_USER_ADMIN = gql`
  mutation adminSetUserAdmin($id: ID!, $isAdmin: Boolean!) {
    adminSetUserAdmin(id: $id, isAdmin: $isAdmin) {
      id
      email
      isAdmin
      suspendedAt
      createdAt
      organizations {
        id
        name
        role
      }
    }
  }
`;

export const ADMIN_DELETE_USER = gql`
  mutation adminDeleteUser($id: ID!) {
    adminDeleteUser(id: $id)
  }
`;

export const ADMIN_ORGANIZATIONS = gql`
  query adminOrganizations($search: String, $page: Int, $pageSize: Int) {
    adminOrganizations(search: $search, page: $page, pageSize: $pageSize) {
      items {
        id
        name
        createdAt
        plan
        members {
          userId
          email
          role
        }
      }
      total
    }
  }
`;

export const ADMIN_ORGANIZATION = gql`
  query adminOrganization($id: ID!) {
    adminOrganization(id: $id) {
      id
      name
      createdAt
      plan
      members {
        userId
        email
        role
      }
    }
  }
`;

export const ADMIN_DELETE_ORGANIZATION = gql`
  mutation adminDeleteOrganization($id: ID!) {
    adminDeleteOrganization(id: $id)
  }
`;

export const ADMIN_CHECKS = gql`
  query adminChecks($status: String, $page: Int, $pageSize: Int) {
    adminChecks(status: $status, page: $page, pageSize: $pageSize) {
      items {
        id
        name
        type
        status
        organizationId
        organizationName
      }
      total
    }
  }
`;

export const ADMIN_PAUSE_CHECK = gql`
  mutation adminPauseCheck($id: ID!) {
    adminPauseCheck(id: $id) {
      id
      status
    }
  }
`;

export const ADMIN_RESUME_CHECK = gql`
  mutation adminResumeCheck($id: ID!) {
    adminResumeCheck(id: $id) {
      id
      status
    }
  }
`;

export const ADMIN_DELETE_CHECK = gql`
  mutation adminDeleteCheck($id: ID!) {
    adminDeleteCheck(id: $id)
  }
`;

export const ADMIN_SUBSCRIPTIONS = gql`
  query adminSubscriptions($page: Int, $pageSize: Int) {
    adminSubscriptions(page: $page, pageSize: $pageSize) {
      items {
        id
        userId
        userEmail
        plan
        status
        manualOverride
        limitsJson
        stripeSubscriptionId
        createdAt
      }
      total
    }
  }
`;

export const ADMIN_SET_USER_PLAN = gql`
  mutation adminSetUserPlan(
    $userId: ID!
    $plan: String!
    $limitsJson: String
    $manualOverride: Boolean
  ) {
    adminSetUserPlan(
      userId: $userId
      plan: $plan
      limitsJson: $limitsJson
      manualOverride: $manualOverride
    ) {
      id
      userId
      userEmail
      plan
      status
      manualOverride
      limitsJson
    }
  }
`;

export const ADMIN_METRICS = gql`
  query adminMetrics {
    adminMetrics {
      totalUsers
      totalOrgs
      totalChecks
      alertsLast24h
      checksByStatus {
        status
        count
      }
      recentSignups {
        id
        email
        createdAt
      }
      signupsPerDay {
        day
        count
      }
    }
  }
`;

export const ADMIN_IMPERSONATE = gql`
  mutation adminImpersonate($userId: ID!) {
    adminImpersonate(userId: $userId) {
      token
      expiresAt
    }
  }
`;

export const ADMIN_AUDIT_LOG = gql`
  query adminAuditLog($page: Int, $pageSize: Int) {
    adminAuditLog(page: $page, pageSize: $pageSize) {
      items {
        id
        actorUserId
        actorEmail
        action
        targetType
        targetId
        createdAt
      }
      total
    }
  }
`;
