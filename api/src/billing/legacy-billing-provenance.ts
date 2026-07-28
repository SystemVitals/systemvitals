import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';

export const LEGACY_BILLING_PROVENANCE_ERROR =
  'Complete account subscription reconciliation before transferring/deleting this organization.';

export async function assertNoUnresolvedLegacyBilling(
  tx: Prisma.TransactionClient,
  organizationId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM subscriptions
    WHERE organization_id = ${organizationId}
      AND user_id IS NULL
      AND stripe_subscription_id IS NOT NULL
      AND status NOT IN ('canceled', 'incomplete_expired')
      AND plan IN ('SIGNAL', 'FLEET')
    FOR UPDATE
  `;
  const unresolved = await tx.subscription.findFirst({
    where: {
      organizationId,
      userId: null,
      stripeSubscriptionId: { not: null },
      status: { notIn: ['canceled', 'incomplete_expired'] },
      plan: { in: ['SIGNAL', 'FLEET'] },
    },
    select: { id: true },
  });
  if (unresolved) {
    throw new BadRequestException(LEGACY_BILLING_PROVENANCE_ERROR);
  }
}
