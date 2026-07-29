import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { isValidSlug, isReservedOrgSlug, slugify } from '../common/slug';
import { createWithUniqueSlug } from '../common/create-with-unique-slug';
import { AccountEntitlementsService } from '../billing/account-entitlements.service';
import { assertNoUnresolvedLegacyBilling } from '../billing/legacy-billing-provenance';

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  pingKey: string;
  role: string;
  plan: string;
  creatorUserId: string;
  creatorLabel: string;
  projects: Array<{
    id: string;
    name: string;
    slug: string;
    pingKey: string;
    organizationId: string;
  }>;
}

export interface UpdateOrganizationInput {
  name?: string | null;
  slug?: string | null;
}

export interface OrganizationCheckAllowance {
  used: number;
  limit: number;
  remaining: number;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: AccountEntitlementsService,
  ) {}

  async organizationCheckAllowance(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationCheckAllowance> {
    return this.prisma.$transaction(async (tx) => {
      const membership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId,
          },
        },
        select: {
          organization: {
            select: { creatorUserId: true },
          },
        },
      });
      if (!membership) {
        throw new ForbiddenException('Not a member of this organization');
      }

      const account = await this.entitlements.forUser(
        tx,
        membership.organization.creatorUserId,
      );
      const limit = account.limits.maxChecks;
      const used = account.checkCount;
      return {
        used,
        limit,
        remaining: Math.max(0, limit - used),
      };
    });
  }

  async create(userId: string, name: string): Promise<OrgRow> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new BadRequestException('Organization name is required');
    }

    let base = slugify(trimmed);
    if (isReservedOrgSlug(base)) base = `${base}-org`;

    return createWithUniqueSlug({
      base,
      entityLabel: 'organization',
      loadTakenSlugs: async () => {
        const orgs = await this.prisma.organization.findMany({
          select: { slug: true },
        });
        return orgs.map((o) => o.slug);
      },
      create: (slug) =>
        this.prisma.$transaction(async (tx) => {
          await this.entitlements.lockUsers(tx, [userId]);
          const accountEntitlements = await this.entitlements.forUser(
            tx,
            userId,
          );
          this.entitlements.assertCanAddOrganization(accountEntitlements);
          const creator = await tx.user.findUniqueOrThrow({
            where: { id: userId },
            select: { email: true },
          });
          const org = await tx.organization.create({
            data: { name: trimmed, slug, creatorUserId: userId },
          });
          await tx.membership.create({
            data: { userId, organizationId: org.id, role: 'OWNER' },
          });
          const project = await tx.project.create({
            data: { name: 'Default', slug: 'default', organizationId: org.id },
          });
          return {
            id: org.id,
            name: org.name,
            slug: org.slug,
            pingKey: project.pingKey,
            role: 'OWNER',
            plan: accountEntitlements.plan,
            creatorUserId: userId,
            creatorLabel: creator.email,
            projects: [project],
          };
        }),
    });
  }

  async update(
    userId: string,
    organizationId: string,
    input: UpdateOrganizationInput,
  ) {
    const hasName = input.name !== undefined && input.name !== null;
    const hasSlug = input.slug !== undefined && input.slug !== null;
    if (!hasName && !hasSlug) {
      throw new BadRequestException('At least one of name or slug is required');
    }

    const data: { name?: string; slug?: string } = {};
    if (hasName) {
      const trimmed = input.name!.trim();
      if (!trimmed) {
        throw new BadRequestException('Organization name is required');
      }
      data.name = trimmed;
    }
    if (hasSlug) {
      const slug = input.slug!;
      if (!isValidSlug(slug)) {
        throw new BadRequestException(
          'Slug must be lowercase letters, numbers and single hyphens',
        );
      }
      if (isReservedOrgSlug(slug)) {
        throw new BadRequestException(
          `Slug "${slug}" is reserved and cannot be used`,
        );
      }
      data.slug = slug;
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Lock the exact membership used for authorization. Role changes and
        // removals must wait until this metadata write commits, so the role
        // checked below cannot go stale before organization.update.
        await tx.$queryRaw`
          SELECT id FROM memberships
          WHERE user_id = ${userId} AND organization_id = ${organizationId}
          FOR UPDATE
        `;
        const membership = await tx.membership.findUnique({
          where: { userId_organizationId: { userId, organizationId } },
        });
        if (
          !membership ||
          (membership.role !== 'OWNER' && membership.role !== 'ADMIN')
        ) {
          throw new ForbiddenException('Requires owner or admin role');
        }

        const org = await tx.organization.update({
          where: { id: organizationId },
          data,
          include: {
            projects: true,
            creator: { include: { subscription: true } },
          },
        });
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          pingKey: org.projects[0].pingKey,
          role: membership.role,
          plan: org.creator.subscription?.plan ?? 'SOLO',
          creatorUserId: org.creatorUserId,
          creatorLabel: org.creator.email,
          projects: org.projects,
        };
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException(
          `An organization with slug "${data.slug}" already exists`,
        );
      }
      throw err;
    }
  }

  rename(userId: string, organizationId: string, name: string) {
    return this.update(userId, organizationId, { name });
  }

  updateSlug(userId: string, organizationId: string, slug: string) {
    return this.update(userId, organizationId, { slug });
  }

  async transferCreatorship(
    callerUserId: string,
    organizationId: string,
    newCreatorUserId: string,
  ): Promise<OrgRow> {
    return this.prisma.$transaction(async (tx) => {
      const initialOrganization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { creatorUserId: true },
      });
      if (!initialOrganization) {
        throw new ForbiddenException('Only the current creator can transfer');
      }
      if (callerUserId === newCreatorUserId) {
        throw new BadRequestException(
          'The new creator must be a different user',
        );
      }

      await this.entitlements.lockUsers(
        tx,
        [initialOrganization.creatorUserId, newCreatorUserId].sort(),
      );

      // Use the same membership lock set as MembersService before fresh role
      // reads. Concurrent owner demotion/removal therefore cannot invalidate
      // either authorization decision before creatorUserId is updated.
      // User rows are always locked first and in sorted order; MembersService
      // never takes user locks, so there is no reverse lock-order cycle.
      await tx.$queryRaw`
        SELECT id FROM memberships
        WHERE organization_id = ${organizationId} AND role = 'OWNER'
        FOR UPDATE
      `;

      const organization = await tx.organization.findUnique({
        where: { id: organizationId },
        include: { projects: true },
      });
      const callerMembership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: callerUserId,
            organizationId,
          },
        },
      });
      if (
        !organization ||
        organization.creatorUserId !== initialOrganization.creatorUserId ||
        organization.creatorUserId !== callerUserId ||
        callerMembership?.role !== 'OWNER'
      ) {
        throw new ForbiddenException(
          organization &&
            organization.creatorUserId !== initialOrganization.creatorUserId
            ? 'Organization creator changed during transfer'
            : 'Caller must still be the creator and an owner',
        );
      }

      const recipientMembership = await tx.membership.findUnique({
        where: {
          userId_organizationId: {
            userId: newCreatorUserId,
            organizationId,
          },
        },
      });
      if (recipientMembership?.role !== 'OWNER') {
        throw new ForbiddenException('The recipient must already be an owner');
      }

      await assertNoUnresolvedLegacyBilling(tx, organizationId);

      const recipientEntitlements = await this.entitlements.forUser(
        tx,
        newCreatorUserId,
      );
      this.entitlements.assertCanAddOrganization(recipientEntitlements);
      const transferredChecks = await tx.check.count({
        where: { project: { organizationId } },
      });
      if (
        recipientEntitlements.checkCount + transferredChecks >
        recipientEntitlements.limits.maxChecks
      ) {
        throw new ForbiddenException(
          `Transfer would exceed the recipient's check limit of ${recipientEntitlements.limits.maxChecks}.`,
        );
      }

      const updated = await tx.organization.update({
        where: { id: organizationId },
        data: { creatorUserId: newCreatorUserId },
        include: {
          projects: true,
          creator: { include: { subscription: true } },
        },
      });
      return {
        id: updated.id,
        name: updated.name,
        slug: updated.slug,
        pingKey: updated.projects[0].pingKey,
        role: callerMembership.role,
        plan: updated.creator.subscription?.plan ?? 'SOLO',
        creatorUserId: updated.creatorUserId,
        creatorLabel: updated.creator.email,
        projects: updated.projects,
      };
    });
  }

  async remove(userId: string, organizationId: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const initialOrganization = await tx.organization.findUnique({
        where: { id: organizationId },
        select: { creatorUserId: true },
      });
      if (!initialOrganization) {
        throw new ForbiddenException('Requires owner role');
      }
      await this.entitlements.lockUsers(tx, [
        userId,
        initialOrganization.creatorUserId,
      ]);

      // Lock the caller's membership rows so two concurrent deletes cannot both
      // pass the last-org check and leave the user with zero orgs (write skew;
      // mirrors members.service.ts assertNotLastOwner). Prisma's fluent API
      // can't express FOR UPDATE, so use $queryRaw with a tagged template (the
      // interpolated value is parameterized, never concatenated).
      await tx.$queryRaw`
        SELECT id FROM memberships WHERE user_id = ${userId} FOR UPDATE
      `;
      await tx.$queryRaw`
        SELECT id FROM organizations WHERE id = ${organizationId} FOR UPDATE
      `;

      const [membership, organization] = await Promise.all([
        tx.membership.findUnique({
          where: { userId_organizationId: { userId, organizationId } },
        }),
        tx.organization.findUnique({
          where: { id: organizationId },
          select: { creatorUserId: true },
        }),
      ]);
      if (!membership || membership.role !== 'OWNER') {
        throw new ForbiddenException('Requires owner role');
      }
      if (
        !organization ||
        organization.creatorUserId !== initialOrganization.creatorUserId
      ) {
        throw new BadRequestException(
          'Organization creator changed during deletion',
        );
      }

      // A user must always belong to at least one organization.
      const total = await tx.membership.count({ where: { userId } });
      if (total <= 1) {
        throw new BadRequestException(
          'You must belong to at least one organization; you cannot delete your only one.',
        );
      }

      await assertNoUnresolvedLegacyBilling(tx, organizationId);
      await tx.organization.delete({ where: { id: organizationId } });
      return true;
    });
  }
}
