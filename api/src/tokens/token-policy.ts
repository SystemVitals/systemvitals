import { ForbiddenException } from '@nestjs/common';
import type { ApiPrincipal, TokenCapability } from './api-principal';

const SCOPED_TOKEN_OPERATIONS = new Set([
  'apiCredential',
  'managedTelegramBot',
  'checks',
  'check',
  'checkBySlug',
  'checkByOrganizationSlug',
  'events',
  'nextExpectedAt',
  'notificationChannelIds',
  'createCheck',
  'createActiveCheck',
  'updateCheck',
  'setCheckChannelEnabled',
  'pauseCheck',
  'resumeCheck',
  'deleteCheck',
]);

const SESSION_ONLY_OPERATIONS = new Set([
  'telegramConnectionPreview',
  'connectTelegramChannel',
  'moveCheck',
  'organizationCheckAllowance',
]);

const ACCOUNT_TOKEN_OPERATIONS = new Set([
  ...SCOPED_TOKEN_OPERATIONS,
  'telegramConnectionPreview',
  'connectTelegramChannel',
  'moveCheck',
  'organizationCheckAllowance',
  'me',
  'projects',
  'mySubscription',
  'createOrganization',
  'updateOrganization',
  'updateOrganizationSlug',
  'transferOrganizationCreatorship',
  'deleteOrganization',
  'regenerateOrganizationPingKey',
  'regeneratePingKey',
  'channels',
  'createChannel',
  'resendEmailChannelVerification',
  'deleteChannel',
  'organizationMembers',
  'organizationInvites',
  'inviteMember',
  'revokeInvite',
  'acceptInvite',
  'updateMemberRole',
  'removeMember',
  'leaveOrganization',
  'statusPages',
  'createStatusPage',
  'updateStatusPage',
  'deleteStatusPage',
  'createBillingCheckout',
  'createBillingPortal',
]);

export function isAccountToken(principal: ApiPrincipal): boolean {
  return (
    principal.authKind === 'api-token' &&
    principal.apiToken.projectId === null &&
    principal.apiToken.capabilities.length === 1 &&
    principal.apiToken.capabilities[0] === 'account:manage' &&
    principal.apiToken.legacyScopes.length === 0
  );
}

export function requireOperationAccess(
  principal: ApiPrincipal,
  operationName: string,
): void {
  if (principal.authKind === 'session') return;

  if (isAccountToken(principal)) {
    if (!ACCOUNT_TOKEN_OPERATIONS.has(operationName)) {
      throw new ForbiddenException(
        'Account credential cannot access this operation',
      );
    }
    return;
  }

  if (SESSION_ONLY_OPERATIONS.has(operationName)) {
    throw new ForbiddenException('Account session required');
  }

  const token = principal.apiToken;
  const isScoped = token.projectId !== null || token.capabilities.length > 0;
  const isLegacyBroad = !isScoped && token.legacyScopes.length > 0;
  if (isLegacyBroad) return;

  if (!SCOPED_TOKEN_OPERATIONS.has(operationName)) {
    throw new ForbiddenException(
      'Scoped credential cannot access this operation',
    );
  }
}

export function requireCheckAccess(
  principal: ApiPrincipal,
  capability: TokenCapability,
  projectId: string,
): void {
  if (principal.authKind === 'session' || isAccountToken(principal)) return;

  const token = principal.apiToken;
  if (token.projectId !== null && token.projectId !== projectId) {
    throw new ForbiddenException('Credential is bound to a different project');
  }

  const hasCapability = token.capabilities.includes(capability);
  const hasLegacyAccess =
    token.legacyScopes.includes('write') ||
    (capability === 'checks:read' && token.legacyScopes.includes('read'));

  if (!hasCapability && !hasLegacyAccess) {
    throw new ForbiddenException(`Missing capability: ${capability}`);
  }
}
