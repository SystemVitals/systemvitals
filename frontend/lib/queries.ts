import { gql } from "@apollo/client";
export { CHECK_BY_SLUG } from "./legacy-queries";

export const CHECKS = gql`
  query checks($organizationId: ID!) {
    checks(organizationId: $organizationId) {
      id
      name
      slug
      type
      status
      pingSlug
      periodSeconds
      intervalSeconds
      graceSeconds
      schedule
      tz
      nextExpectedAt
      lastEventAt
      notificationChannelIds
    }
  }
`;

export const CHECK = gql`
  query check($id: ID!) {
    check(id: $id) {
      id
      organizationId
      notificationChannelIds
      name
      slug
      type
      target
      method
      expectedStatus
      intervalSeconds
      timeoutMs
      periodSeconds
      graceSeconds
      schedule
      tz
      nextExpectedAt
      status
      pingSlug
      events(limit: 50) {
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

export const CREATE_CHECK = gql`
  mutation createCheck(
    $organizationId: ID!
    $name: String!
    $graceSeconds: Int!
    $periodSeconds: Int
    $schedule: String
    $tz: String
  ) {
    createCheck(
      organizationId: $organizationId
      name: $name
      graceSeconds: $graceSeconds
      periodSeconds: $periodSeconds
      schedule: $schedule
      tz: $tz
    ) {
      id
    }
  }
`;

export const PAUSE_CHECK = gql`
  mutation pauseCheck($id: ID!) {
    pauseCheck(id: $id) {
      id
      status
    }
  }
`;

export const RESUME_CHECK = gql`
  mutation resumeCheck($id: ID!) {
    resumeCheck(id: $id) {
      id
      status
    }
  }
`;

export const MOVE_CHECK = gql`
  mutation MoveCheck($checkId: ID!, $destinationProjectId: ID!) {
    moveCheck(
      checkId: $checkId
      destinationProjectId: $destinationProjectId
    ) {
      id
      projectId
      slug
    }
  }
`;

export const CHANNELS = gql`
  query channels($organizationId: ID!) {
    channels(organizationId: $organizationId) {
      id
      organizationId
      type
      configJson
      enabled
      verificationStatus
      verificationDeliveryStatus
      verificationExpiresAt
    }
  }
`;

export const SET_CHECK_CHANNEL_ENABLED = gql`
  mutation SetCheckChannelEnabled($checkId: ID!, $channelId: ID!, $enabled: Boolean!) {
    setCheckChannelEnabled(checkId: $checkId, channelId: $channelId, enabled: $enabled) {
      id
      notificationChannelIds
    }
  }
`;

export const CREATE_CHANNEL = gql`
  mutation createChannel($organizationId: ID!, $type: String!, $configJson: String!) {
    createChannel(organizationId: $organizationId, type: $type, configJson: $configJson) {
      id
      organizationId
      enabled
      verificationStatus
      verificationDeliveryStatus
      verificationExpiresAt
    }
  }
`;

export const RESEND_EMAIL_CHANNEL_VERIFICATION = gql`
  mutation resendEmailChannelVerification($channelId: ID!) {
    resendEmailChannelVerification(channelId: $channelId) {
      id
      enabled
      verificationStatus
      verificationDeliveryStatus
      verificationExpiresAt
    }
  }
`;

export const EMAIL_CHANNEL_VERIFICATION_PREVIEW = gql`
  query emailChannelVerificationPreview($token: String!) {
    emailChannelVerificationPreview(token: $token) {
      status
      maskedEmail
      projectName
      expiresAt
    }
  }
`;

export const VERIFY_EMAIL_CHANNEL = gql`
  mutation verifyEmailChannel($token: String!) {
    verifyEmailChannel(token: $token) {
      status
      maskedEmail
      projectName
    }
  }
`;

export const DELETE_CHANNEL = gql`
  mutation deleteChannel($id: ID!) {
    deleteChannel(id: $id)
  }
`;

export const MANAGED_TELEGRAM_BOT = gql`
  query managedTelegramBot {
    managedTelegramBot {
      available
      username
    }
  }
`;

export const TELEGRAM_CONNECTION_PREVIEW = gql`
  query telegramConnectionPreview($token: String!) {
    telegramConnectionPreview(token: $token) {
      chatId
      chatType
      chatTitle
      messageThreadId
      expiresAt
    }
  }
`;

export const CONNECT_TELEGRAM_CHANNEL = gql`
  mutation connectTelegramChannel($token: String!, $projectId: ID!) {
    connectTelegramChannel(token: $token, projectId: $projectId) {
      id
      type
      configJson
      enabled
      projectId
    }
  }
`;

export const STATUS_PAGES = gql`
  query statusPages($organizationId: ID!) {
    statusPages(organizationId: $organizationId) {
      id
      organizationId
      slug
      title
      checkIds
    }
  }
`;

export const CREATE_STATUS_PAGE = gql`
  mutation createStatusPage(
    $organizationId: ID!
    $slug: String!
    $title: String!
    $checkIds: [ID!]!
    $brandingJson: String
  ) {
    createStatusPage(
      organizationId: $organizationId
      slug: $slug
      title: $title
      checkIds: $checkIds
      brandingJson: $brandingJson
    ) {
      id
      organizationId
      slug
    }
  }
`;

export const UPDATE_STATUS_PAGE = gql`
  mutation updateStatusPage(
    $id: ID!
    $title: String
    $checkIds: [ID!]
    $brandingJson: String
  ) {
    updateStatusPage(
      id: $id
      title: $title
      checkIds: $checkIds
      brandingJson: $brandingJson
    ) {
      id
    }
  }
`;

export const DELETE_STATUS_PAGE = gql`
  mutation deleteStatusPage($id: ID!) {
    deleteStatusPage(id: $id)
  }
`;

export const MY_SUBSCRIPTION = gql`
  query mySubscription {
    mySubscription {
      plan
      status
      checkCount
      maxChecks
      organizationCount
    }
  }
`;

export const SET_PASSWORD = gql`
  mutation SetPassword($newPassword: String!, $currentPassword: String) {
    setPassword(newPassword: $newPassword, currentPassword: $currentPassword)
  }
`;

export const UPDATE_CHECK = gql`
  mutation UpdateCheck($id: ID!, $input: UpdateCheckInput!) {
    updateCheck(id: $id, input: $input) {
      id
      name
      slug
      type
      status
      pingSlug
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
  }
`;

export const UPDATE_ORGANIZATION_SLUG = gql`
  mutation UpdateOrganizationSlug($organizationId: ID!, $slug: String!) {
    updateOrganizationSlug(organizationId: $organizationId, slug: $slug) {
      id
      name
      slug
    }
  }
`;

export const CREATE_ORGANIZATION = gql`
  mutation CreateOrganization($name: String!) {
    createOrganization(name: $name) {
      id
      name
      slug
      role
      plan
    }
  }
`;

export const UPDATE_ORGANIZATION = gql`
  mutation UpdateOrganization($organizationId: ID!, $name: String!) {
    updateOrganization(organizationId: $organizationId, name: $name) {
      id
      name
      slug
    }
  }
`;

export const DELETE_ORGANIZATION = gql`
  mutation DeleteOrganization($organizationId: ID!) {
    deleteOrganization(organizationId: $organizationId)
  }
`;

export const TRANSFER_ORGANIZATION_CREATORSHIP = gql`
  mutation TransferOrganizationCreatorship(
    $organizationId: ID!
    $newCreatorUserId: ID!
  ) {
    transferOrganizationCreatorship(
      organizationId: $organizationId
      newCreatorUserId: $newCreatorUserId
    ) {
      id
      creatorUserId
      creatorLabel
      plan
    }
  }
`;

export const CREATE_ACTIVE_CHECK = gql`
  mutation createActiveCheck(
    $organizationId: ID!
    $name: String!
    $type: String!
    $target: String!
    $intervalSeconds: Int!
    $timeoutMs: Int!
    $method: String
    $expectedStatus: Int
  ) {
    createActiveCheck(
      organizationId: $organizationId
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
  }
`;

export const ORGANIZATION_MEMBERS = gql`
  query organizationMembers($organizationId: ID!) {
    organizationMembers(organizationId: $organizationId) {
      id
      userId
      email
      role
      createdAt
    }
  }
`;

export const ORGANIZATION_INVITES = gql`
  query organizationInvites($organizationId: ID!) {
    organizationInvites(organizationId: $organizationId) {
      id
      email
      role
      token
      acceptUrl
      expiresAt
    }
  }
`;

export const INVITE_MEMBER = gql`
  mutation inviteMember($organizationId: ID!, $email: String!, $role: String!) {
    inviteMember(organizationId: $organizationId, email: $email, role: $role) {
      id
      email
      role
      acceptUrl
    }
  }
`;

export const REVOKE_INVITE = gql`
  mutation revokeInvite($inviteId: ID!) {
    revokeInvite(inviteId: $inviteId)
  }
`;

export const UPDATE_MEMBER_ROLE = gql`
  mutation updateMemberRole($membershipId: ID!, $role: String!) {
    updateMemberRole(membershipId: $membershipId, role: $role) {
      id
      role
    }
  }
`;

export const REMOVE_MEMBER = gql`
  mutation removeMember($membershipId: ID!) {
    removeMember(membershipId: $membershipId)
  }
`;

export const INVITE_PREVIEW = gql`
  query invitePreview($token: String!) {
    invitePreview(token: $token) {
      organizationName
      maskedEmail
      status
    }
  }
`;

export const ACCEPT_INVITE = gql`
  mutation acceptInvite($token: String!) {
    acceptInvite(token: $token) {
      id
      email
      role
    }
  }
`;

export const LEAVE_ORGANIZATION = gql`
  mutation LeaveOrganization($organizationId: ID!) {
    leaveOrganization(organizationId: $organizationId)
  }
`;

export const CREATE_API_TOKEN = gql`
  mutation CreateScopedApiToken($input: CreateApiTokenInput!) {
    createScopedApiToken(input: $input) {
      id
      name
      scopes
      projectId
      expiresAt
      plaintext
    }
  }
`;

export const API_TOKENS = gql`
  query ApiTokens {
    apiTokens {
      id
      name
      prefix
      scopes
      projectId
      projectName
      organizationName
      createdAt
      expiresAt
      lastUsedAt
      revokedAt
    }
  }
`;

export const REVOKE_API_TOKEN = gql`
  mutation RevokeApiToken($id: ID!) {
    revokeApiToken(id: $id)
  }
`;
