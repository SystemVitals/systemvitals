import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import type { Prisma, Role } from '@systemvitals/database';
import { normalizeEmail } from '../common/email';
import { PrismaService } from '../prisma/prisma.service';
import { InviteQueueService } from '../queue/invite-queue.service';

/** Pending invites stop being acceptable this many days after creation. */
export const INVITE_TTL_DAYS = 7;

/** Higher rank may manage lower rank. */
export const ROLE_RANK: Record<Role, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
};

export interface MemberRow {
  id: string;
  userId: string;
  email: string;
  role: Role;
  createdAt: Date;
}

export interface InviteRow {
  id: string;
  email: string;
  role: Role;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}

export type InviteStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'REVOKED'
  | 'EXPIRED'
  | 'NOT_FOUND';

export interface InvitePreview {
  organizationName: string;
  maskedEmail: string;
  status: InviteStatus;
}

/**
 * Reveal only the first character of the local part. Used by the unauthenticated
 * invite-preview query so a token holder can confirm which address was invited
 * without the full address leaking to anyone who guesses a token.
 */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inviteQueue: InviteQueueService,
  ) {}

  /** Returns the caller's membership, or throws if they are not in the org. */
  private async requireMembership(userId: string, organizationId: string) {
    const m = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this organization');
    return m;
  }

  /**
   * Assert the caller may manage members in this org, and return their role.
   * OWNER and ADMIN qualify; MEMBER does not.
   */
  private async requireManager(
    userId: string,
    organizationId: string,
  ): Promise<Role> {
    const m = await this.requireMembership(userId, organizationId);
    if (m.role !== 'OWNER' && m.role !== 'ADMIN') {
      throw new ForbiddenException('Requires owner or admin role');
    }
    return m.role;
  }

  /**
   * An ADMIN may only act on plain MEMBERs; an OWNER may act on anyone.
   * Shared by invite() and revokeInvite() so the rule cannot drift.
   */
  private assertRankAllows(actorRole: Role, targetRole: Role): void {
    if (actorRole === 'ADMIN' && targetRole !== 'MEMBER') {
      throw new ForbiddenException('Admins can only manage members');
    }
  }

  async listMembers(
    userId: string,
    organizationId: string,
  ): Promise<MemberRow[]> {
    await this.requireMembership(userId, organizationId);
    const rows = await this.prisma.membership.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      id: m.id,
      userId: m.user.id,
      email: m.user.email,
      role: m.role,
      createdAt: m.createdAt,
    }));
  }

  async listInvites(
    userId: string,
    organizationId: string,
  ): Promise<InviteRow[]> {
    await this.requireManager(userId, organizationId);
    const rows = await this.prisma.invite.findMany({
      where: {
        organizationId,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      token: i.token,
      expiresAt: i.expiresAt,
      createdAt: i.createdAt,
    }));
  }

  private get appUrl(): string {
    return process.env.APP_URL ?? 'http://localhost:9999';
  }

  /** The URL an invitee opens to accept. */
  inviteAcceptUrl(token: string): string {
    return `${this.appUrl}/invite/${token}`;
  }

  async invite(
    userId: string,
    organizationId: string,
    email: string,
    role: Role,
  ): Promise<InviteRow> {
    const actorRole = await this.requireManager(userId, organizationId);

    if (role === 'OWNER') {
      throw new BadRequestException(
        'Cannot invite someone as an owner. Promote them after they join.',
      );
    }
    this.assertRankAllows(actorRole, role);

    const normalized = normalizeEmail(email);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (existingUser) {
      const existingMembership = await this.prisma.membership.findUnique({
        where: {
          userId_organizationId: { userId: existingUser.id, organizationId },
        },
      });
      if (existingMembership) {
        throw new BadRequestException('Already a member of this organization');
      }
    }

    const pending = await this.prisma.invite.findFirst({
      where: {
        organizationId,
        email: normalized,
        acceptedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (pending) {
      throw new BadRequestException(
        'A pending invite already exists for this email',
      );
    }

    const expiresAt = new Date(
      Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    );

    const invite = await this.prisma.invite.create({
      data: {
        email: normalized,
        organizationId,
        role,
        invitedByUserId: userId,
        expiresAt,
        // 256 bits from a CSPRNG. The schema deliberately has no @default:
        // cuid embeds a timestamp and counter and is not built to be
        // unguessable, and this token is a bearer credential that grants
        // organization membership to whoever presents it.
        token: randomBytes(32).toString('hex'),
      },
    });

    await this.inviteQueue.enqueue({ inviteId: invite.id });

    return {
      id: invite.id,
      email: invite.email,
      role: invite.role,
      token: invite.token,
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
    };
  }

  async revokeInvite(userId: string, inviteId: string): Promise<boolean> {
    const invite = await this.prisma.invite.findUnique({
      where: { id: inviteId },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    // Authorize before revealing anything about the invite's state: without
    // this ordering, any authenticated user could probe invite ids and learn
    // whether one exists, or was accepted, or was already revoked.
    const actorRole = await this.requireManager(userId, invite.organizationId);
    this.assertRankAllows(actorRole, invite.role);

    if (invite.acceptedAt) {
      throw new BadRequestException('Invite has already been accepted');
    }
    if (invite.revokedAt) return true;

    await this.prisma.invite.update({
      where: { id: inviteId },
      data: { revokedAt: new Date() },
    });
    return true;
  }

  private inviteStatus(invite: {
    acceptedAt: Date | null;
    revokedAt: Date | null;
    expiresAt: Date;
  }): InviteStatus {
    if (invite.acceptedAt) return 'ACCEPTED';
    if (invite.revokedAt) return 'REVOKED';
    if (invite.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
    return 'PENDING';
  }

  /**
   * Unauthenticated. Deliberately reveals only the org name and a masked email
   * so the accept page can render before the visitor logs in.
   */
  async previewInvite(token: string): Promise<InvitePreview> {
    const invite = await this.prisma.invite.findUnique({
      where: { token },
      include: { organization: { select: { name: true } } },
    });
    if (!invite) {
      return { organizationName: '', maskedEmail: '', status: 'NOT_FOUND' };
    }
    return {
      organizationName: invite.organization.name,
      maskedEmail: maskEmail(invite.email),
      status: this.inviteStatus(invite),
    };
  }

  async accept(userId: string, token: string): Promise<MemberRow> {
    const invite = await this.prisma.invite.findUnique({ where: { token } });
    if (!invite) throw new NotFoundException('Invite not found');

    switch (this.inviteStatus(invite)) {
      case 'ACCEPTED':
        throw new BadRequestException('Invite has already been accepted');
      case 'REVOKED':
        throw new BadRequestException('Invite has been revoked');
      case 'EXPIRED':
        throw new BadRequestException('Invite has expired');
      default:
        break;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (normalizeEmail(user.email) !== invite.email) {
      throw new ForbiddenException(
        'This invite was sent to a different email address',
      );
    }

    // The existence check, the membership create and the invite update share
    // one interactive transaction (matching auth.service.ts#provisionUser) so
    // a raced double-accept and a partial failure can't leave the invite
    // stuck PENDING while the membership row already exists.
    const membership = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const existing = await tx.membership.findUnique({
          where: {
            userId_organizationId: {
              userId,
              organizationId: invite.organizationId,
            },
          },
        });
        if (existing) {
          throw new BadRequestException(
            'Already a member of this organization',
          );
        }

        let created;
        try {
          created = await tx.membership.create({
            data: {
              userId,
              organizationId: invite.organizationId,
              role: invite.role,
            },
          });
        } catch (e: unknown) {
          // Two concurrent accepts of the same token both pass the existence
          // check above; the loser hits the @@unique([userId, organizationId])
          // constraint here. Translate that race into the same clean error the
          // sequential check already throws, rather than letting a raw
          // PrismaClientKnownRequestError surface as an unhandled 500.
          if (
            typeof e === 'object' &&
            e !== null &&
            'code' in e &&
            (e as { code: string }).code === 'P2002'
          ) {
            throw new BadRequestException(
              'Already a member of this organization',
            );
          }
          throw e;
        }

        await tx.invite.update({
          where: { id: invite.id },
          data: { acceptedAt: new Date() },
        });

        return created;
      },
    );

    return {
      id: membership.id,
      userId,
      email: user.email,
      role: membership.role,
      createdAt: membership.createdAt,
    };
  }

  /**
   * Throws unless the org would still have at least one OWNER afterwards.
   *
   * Counting the OWNER rows and later writing were previously two separate
   * round-trips: two owners concurrently vacating *different* OWNER
   * memberships could both read `owners = 2`, both pass, and both writes
   * land, leaving the org with zero owners. That is write skew -- plain
   * `$transaction` does not prevent it, since Postgres permits write skew at
   * both READ COMMITTED and REPEATABLE READ.
   *
   * Take a row lock on the org's OWNER memberships inside the same
   * transaction the caller uses for its fresh reads and write. This lock
   * serializes both the owner-count invariant and creator-membership checks
   * with creatorship transfer.
   */
  private async lockOwnerMemberships(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM memberships
      WHERE organization_id = ${organizationId} AND role = 'OWNER'
      FOR UPDATE
    `;
  }

  private async assertNotLastOwner(
    tx: Prisma.TransactionClient,
    organizationId: string,
    targetRole: Role,
  ): Promise<void> {
    if (targetRole !== 'OWNER') return;

    const owners = await tx.membership.count({
      where: { organizationId, role: 'OWNER' },
    });
    if (owners <= 1) {
      throw new BadRequestException(
        'Organization must have at least one owner',
      );
    }
  }

  private async loadTarget(membershipId: string) {
    const target = await this.prisma.membership.findUnique({
      where: { id: membershipId },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!target) throw new NotFoundException('Member not found');
    return target;
  }

  async updateRole(
    userId: string,
    membershipId: string,
    role: Role,
  ): Promise<MemberRow> {
    const target = await this.loadTarget(membershipId);

    const actor = await this.requireMembership(userId, target.organizationId);
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException('Requires owner role');
    }

    // The invariant check and the write share one transaction (see
    // assertNotLastOwner) so the two can no longer race across separate
    // round-trips. The role driving both the lock decision and the
    // invariant check is re-read here, inside the transaction, rather than
    // taken from `target` above: a concurrent transaction could have
    // promoted this membership to OWNER after `loadTarget` ran but before
    // this transaction started, and the stale snapshot would then believe
    // it wasn't touching an owner row at all -- taking no lock, running no
    // count, and writing blindly. See assertNotLastOwner for the lock this
    // depends on.
    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await this.lockOwnerMemberships(tx, target.organizationId);
        const [organization, fresh] = await Promise.all([
          tx.organization.findUnique({
            where: { id: target.organizationId },
            select: { creatorUserId: true },
          }),
          tx.membership.findUnique({
            where: { id: membershipId },
          }),
        ]);
        if (!fresh) throw new NotFoundException('Member not found');

        if (
          fresh.role !== role &&
          fresh.userId === organization?.creatorUserId
        ) {
          throw new BadRequestException(
            'Transfer organization creatorship first',
          );
        }

        if (fresh.role !== role) {
          await this.assertNotLastOwner(tx, fresh.organizationId, fresh.role);
        }
        return tx.membership.update({
          where: { id: membershipId },
          data: { role },
          include: { user: { select: { id: true, email: true } } },
        });
      },
    );

    return {
      id: updated.id,
      userId: updated.user.id,
      email: updated.user.email,
      role: updated.role,
      createdAt: updated.createdAt,
    };
  }

  async removeMember(userId: string, membershipId: string): Promise<boolean> {
    const target = await this.loadTarget(membershipId);

    const actorRole = await this.requireManager(userId, target.organizationId);
    this.assertRankAllows(actorRole, target.role);

    // See updateRole for why the role feeding assertNotLastOwner is
    // re-read inside the transaction rather than taken from `target`.
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockOwnerMemberships(tx, target.organizationId);
      const [organization, fresh] = await Promise.all([
        tx.organization.findUnique({
          where: { id: target.organizationId },
          select: { creatorUserId: true },
        }),
        tx.membership.findUnique({ where: { id: membershipId } }),
      ]);
      if (!fresh) throw new NotFoundException('Member not found');

      if (fresh.userId === organization?.creatorUserId) {
        throw new BadRequestException(
          'Transfer organization creatorship first',
        );
      }
      await this.assertNotLastOwner(tx, fresh.organizationId, fresh.role);
      await tx.membership.delete({ where: { id: membershipId } });
    });
    return true;
  }

  async leave(userId: string, organizationId: string): Promise<boolean> {
    const membership = await this.requireMembership(userId, organizationId);

    // Same fresh re-read as updateRole/removeMember, applied here for
    // consistency even though `leave` has no separate authorization step
    // that could itself go stale.
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockOwnerMemberships(tx, organizationId);
      const [organization, fresh] = await Promise.all([
        tx.organization.findUnique({
          where: { id: organizationId },
          select: { creatorUserId: true },
        }),
        tx.membership.findUnique({ where: { id: membership.id } }),
      ]);
      if (!fresh) throw new NotFoundException('Member not found');

      if (fresh.userId === organization?.creatorUserId) {
        throw new ForbiddenException('Transfer organization creatorship first');
      }
      await this.assertNotLastOwner(tx, fresh.organizationId, fresh.role);
      await tx.membership.delete({ where: { id: membership.id } });
    });
    return true;
  }
}
