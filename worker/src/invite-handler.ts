import type { Prisma, PrismaClient } from "@systemvitals/database";
import type { Mailer } from "./mailer.js";

export interface InviteJob {
  inviteId: string;
}

/** Include shape needed to render the invite email: org name + inviter email. */
const inviteInclude = {
  organization: { select: { name: true } },
  invitedBy: { select: { email: true } },
} satisfies Prisma.InviteInclude;

type InviteWithRelations = Prisma.InviteGetPayload<{
  include: typeof inviteInclude;
}>;

export interface InviteDeps {
  mailer: Mailer;
  appUrl: string;
}

/**
 * Emails a pending invite. Re-checks the invite is still pending at send time,
 * so a revoke that lands between enqueue and delivery wins.
 *
 * Returns true when a mail was sent.
 */
export async function handleInvite(
  prisma: Pick<PrismaClient, "invite">,
  deps: InviteDeps,
  job: InviteJob,
): Promise<boolean> {
  const invite: InviteWithRelations | null = await prisma.invite.findUnique({
    where: { id: job.inviteId },
    include: inviteInclude,
  });

  if (!invite) return false;
  if (invite.acceptedAt || invite.revokedAt) return false;
  if (invite.expiresAt.getTime() <= Date.now()) return false;

  const acceptUrl = `${deps.appUrl}/invite/${invite.token}`;
  const org = invite.organization.name;

  await deps.mailer.send({
    to: invite.email,
    subject: `${invite.invitedBy.email} invited you to ${org} on SystemVitals`,
    text: [
      `${invite.invitedBy.email} invited you to join ${org} on SystemVitals`,
      `as a ${invite.role.toLowerCase()}.`,
      ``,
      `Accept the invite:`,
      acceptUrl,
      ``,
      `This link expires on ${invite.expiresAt.toUTCString()}.`,
      `If you weren't expecting this, you can ignore this email.`,
    ].join("\n"),
  });

  return true;
}
