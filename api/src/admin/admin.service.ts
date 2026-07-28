import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, PlanTier } from '@systemvitals/database';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import type {
  AdminUserModel,
  AdminUserList,
  AdminOrganizationModel,
  AdminOrgList,
  AdminProjectModel,
  AdminProjectList,
  AdminCheckModel,
  AdminCheckList,
  AdminSubscriptionModel,
  AdminSubscriptionList,
  AdminMetrics,
  ImpersonationResult,
  AuditLogModel,
  AuditLogList,
} from './admin.model';
import { AccountEntitlementsService } from '../billing/account-entitlements.service';
import { assertNoUnresolvedLegacyBilling } from '../billing/legacy-billing-provenance';

const ADMIN_LIMIT_KEYS = ['maxChecks', 'minIntervalSeconds'] as const;

export function parseAdminLimits(
  limitsJson: string | null | undefined,
): Prisma.InputJsonObject | undefined {
  if (limitsJson == null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(limitsJson);
  } catch {
    throw new BadRequestException('limitsJson is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BadRequestException('limitsJson must be a JSON object');
  }
  const limits = parsed as Record<string, unknown>;
  const normalized: Record<string, number> = {};
  for (const key of Object.keys(limits)) {
    if (!(ADMIN_LIMIT_KEYS as readonly string[]).includes(key)) {
      throw new BadRequestException(`limitsJson has unsupported key "${key}"`);
    }
    const value = limits[key];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      !Number.isInteger(value) ||
      value <= 0
    ) {
      throw new BadRequestException(
        `limitsJson.${key} must be a finite positive integer`,
      );
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

@Injectable()
export class AdminService {
  constructor(
    readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly entitlements: AccountEntitlementsService,
  ) {}

  /** Write an audit row for an admin action. Call inside every admin mutation. */
  async audit(
    actorUserId: string,
    action: string,
    targetType?: string,
    targetId?: string,
    metadata?: Prisma.InputJsonValue,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorUserId,
        action,
        targetType,
        targetId,
        metadata: metadata ?? Prisma.JsonNull,
      },
    });
  }

  // ─── Users ───────────────────────────────────────────────────────────────────

  async users(
    search?: string | null,
    page = 0,
    pageSize = 25,
  ): Promise<AdminUserList> {
    const where = search
      ? { email: { contains: search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: page * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { memberships: { include: { organization: true } } },
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: items.map((u) => this.mapUser(u)),
      total,
    };
  }

  async user(id: string): Promise<AdminUserModel> {
    const u = await this.prisma.user.findUnique({
      where: { id },
      include: { memberships: { include: { organization: true } } },
    });
    if (!u) throw new NotFoundException('User not found');
    return this.mapUser(u);
  }

  async suspendUser(actorId: string, id: string): Promise<AdminUserModel> {
    if (actorId === id)
      throw new BadRequestException('You cannot suspend yourself');
    await this.prisma.user.update({
      where: { id },
      data: { suspendedAt: new Date() },
    });
    await this.audit(actorId, 'user.suspend', 'user', id);
    return this.user(id);
  }

  async unsuspendUser(actorId: string, id: string): Promise<AdminUserModel> {
    if (actorId === id)
      throw new BadRequestException('You cannot unsuspend yourself');
    await this.prisma.user.update({
      where: { id },
      data: { suspendedAt: null },
    });
    await this.audit(actorId, 'user.unsuspend', 'user', id);
    return this.user(id);
  }

  async setUserAdmin(
    actorId: string,
    id: string,
    isAdmin: boolean,
  ): Promise<AdminUserModel> {
    if (actorId === id && !isAdmin)
      throw new BadRequestException('You cannot demote yourself');
    await this.prisma.user.update({ where: { id }, data: { isAdmin } });
    await this.audit(
      actorId,
      isAdmin ? 'user.promote' : 'user.demote',
      'user',
      id,
      { isAdmin },
    );
    return this.user(id);
  }

  async deleteUser(actorId: string, id: string): Promise<boolean> {
    if (actorId === id)
      throw new BadRequestException('You cannot delete yourself');
    return this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [id]);
      const target = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          checkoutAttemptId: true,
          checkoutAttemptPlan: true,
          checkoutAttemptInterval: true,
          checkoutAttemptCreatedAt: true,
          checkoutSessionId: true,
          checkoutSessionUrl: true,
          checkoutSessionExpiresAt: true,
          checkoutCleanupSessionId: true,
          checkoutCleanupCreatedAt: true,
          subscription: {
            select: {
              plan: true,
              status: true,
              stripeSubscriptionId: true,
            },
          },
        },
      });
      if (!target) throw new NotFoundException('User not found');

      const createdOrganizationCount = await tx.organization.count({
        where: { creatorUserId: id },
      });
      if (createdOrganizationCount > 0) {
        throw new BadRequestException(
          'Transfer organization creatorship before deleting this account',
        );
      }
      const cleanupIntentCount = await tx.checkoutCleanupIntent.count({
        where: { userId: id },
      });
      const checkoutOperationCount = await tx.checkoutOperation.count({
        where: { userId: id },
      });

      const hasUnresolvedCheckout = [
        target.checkoutAttemptId,
        target.checkoutAttemptPlan,
        target.checkoutAttemptInterval,
        target.checkoutAttemptCreatedAt,
        target.checkoutSessionId,
        target.checkoutSessionUrl,
        target.checkoutSessionExpiresAt,
        target.checkoutCleanupSessionId,
        target.checkoutCleanupCreatedAt,
      ].some((value) => value !== null && value !== undefined);
      if (
        hasUnresolvedCheckout ||
        cleanupIntentCount > 0 ||
        checkoutOperationCount > 0
      ) {
        throw new BadRequestException(
          'Resolve account checkout before deleting this account',
        );
      }

      const subscription = target.subscription;
      const hasLiveStatus = ['active', 'trialing', 'past_due'].includes(
        subscription?.status ?? '',
      );
      const hasLivePaidBilling =
        hasLiveStatus &&
        (subscription?.stripeSubscriptionId != null ||
          subscription?.plan !== PlanTier.SOLO);
      if (hasLivePaidBilling) {
        throw new BadRequestException(
          'Cancel account billing before deleting this account',
        );
      }

      await tx.user.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'user.delete',
          targetType: 'user',
          targetId: id,
          metadata: Prisma.JsonNull,
        },
      });
      return true;
    });
  }

  // ─── Impersonation ────────────────────────────────────────────────────────────

  async impersonate(
    actorId: string,
    userId: string,
  ): Promise<ImpersonationResult> {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!target) throw new NotFoundException('User not found');
    if (target.suspendedAt)
      throw new BadRequestException('Cannot impersonate a suspended user');
    await this.audit(actorId, 'impersonate', 'user', userId);
    return this.auth.signImpersonation(userId, target.email, actorId);
  }

  // ─── Audit Log ────────────────────────────────────────────────────────────────

  async auditLog(page = 0, pageSize = 25): Promise<AuditLogList> {
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        skip: page * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { email: true } } },
      }),
      this.prisma.auditLog.count(),
    ]);
    return {
      items: items.map((log) => this.mapAuditLog(log)),
      total,
    };
  }

  // ─── Organizations ────────────────────────────────────────────────────────────

  async organizations(
    search?: string | null,
    page = 0,
    pageSize = 25,
  ): Promise<AdminOrgList> {
    const where = search
      ? { name: { contains: search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await Promise.all([
      this.prisma.organization.findMany({
        where,
        skip: page * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          memberships: { include: { user: true } },
          projects: { select: { id: true } },
          creator: { include: { subscription: { select: { plan: true } } } },
        },
      }),
      this.prisma.organization.count({ where }),
    ]);
    return {
      items: items.map((o) => this.mapOrg(o)),
      total,
    };
  }

  async organization(id: string): Promise<AdminOrganizationModel> {
    const o = await this.prisma.organization.findUnique({
      where: { id },
      include: {
        memberships: { include: { user: true } },
        projects: { select: { id: true } },
        creator: { include: { subscription: { select: { plan: true } } } },
      },
    });
    if (!o) throw new NotFoundException('Organization not found');
    return this.mapOrg(o);
  }

  async deleteOrganization(actorId: string, id: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const initialOrganization = await tx.organization.findUnique({
        where: { id },
        select: { creatorUserId: true },
      });
      if (!initialOrganization) {
        throw new NotFoundException('Organization not found');
      }
      await this.entitlements.lockUsers(tx, [
        initialOrganization.creatorUserId,
      ]);
      await tx.$queryRaw`
        SELECT id FROM organizations WHERE id = ${id} FOR UPDATE
      `;
      const organization = await tx.organization.findUnique({
        where: { id },
        select: { creatorUserId: true },
      });
      if (!organization) {
        throw new NotFoundException('Organization not found');
      }
      if (organization.creatorUserId !== initialOrganization.creatorUserId) {
        throw new BadRequestException(
          'Organization creator changed during deletion',
        );
      }

      await assertNoUnresolvedLegacyBilling(tx, id);
      await tx.organization.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'organization.delete',
          targetType: 'organization',
          targetId: id,
          metadata: Prisma.JsonNull,
        },
      });
      return true;
    });
  }

  // ─── Projects ─────────────────────────────────────────────────────────────────

  async projects(
    search?: string | null,
    page = 0,
    pageSize = 25,
  ): Promise<AdminProjectList> {
    const where = search
      ? { name: { contains: search, mode: 'insensitive' as const } }
      : {};
    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where,
        skip: page * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          organization: true,
          _count: { select: { checks: true } },
        },
      }),
      this.prisma.project.count({ where }),
    ]);
    return {
      items: items.map((p) => this.mapProject(p)),
      total,
    };
  }

  // ─── Checks ───────────────────────────────────────────────────────────────────

  async checks(
    status?: string | null,
    page = 0,
    pageSize = 25,
  ): Promise<AdminCheckList> {
    const where = status ? { status: status as never } : {};
    const [items, total] = await Promise.all([
      this.prisma.check.findMany({
        where,
        skip: page * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { project: { include: { organization: true } } },
      }),
      this.prisma.check.count({ where }),
    ]);
    return {
      items: items.map((c) => this.mapCheck(c)),
      total,
    };
  }

  async pauseCheck(actorId: string, checkId: string): Promise<AdminCheckModel> {
    const check = await this.prisma.check.findUnique({
      where: { id: checkId },
      include: { project: { include: { organization: true } } },
    });
    if (!check) throw new NotFoundException('Check not found');
    const updated = await this.prisma.check.update({
      where: { id: checkId },
      data: { status: 'PAUSED' },
      include: { project: { include: { organization: true } } },
    });
    await this.audit(actorId, 'check.pause', 'check', checkId);
    return this.mapCheck(updated);
  }

  async resumeCheck(
    actorId: string,
    checkId: string,
  ): Promise<AdminCheckModel> {
    const check = await this.prisma.check.findUnique({
      where: { id: checkId },
      include: { project: { include: { organization: true } } },
    });
    if (!check) throw new NotFoundException('Check not found');
    const updated = await this.prisma.check.update({
      where: { id: checkId },
      data: { status: 'NEW' },
      include: { project: { include: { organization: true } } },
    });
    await this.audit(actorId, 'check.resume', 'check', checkId);
    return this.mapCheck(updated);
  }

  async deleteCheck(actorId: string, checkId: string): Promise<boolean> {
    const check = await this.prisma.check.findUnique({
      where: { id: checkId },
    });
    if (!check) throw new NotFoundException('Check not found');
    // Audit BEFORE delete so the check id survives in logs
    await this.audit(actorId, 'check.delete', 'check', checkId);
    await this.prisma.check.delete({ where: { id: checkId } });
    return true;
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────────

  async subscriptions(page = 0, pageSize = 25): Promise<AdminSubscriptionList> {
    const [items, total] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { userId: { not: null } },
        skip: page * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { email: true } } },
      }),
      this.prisma.subscription.count({ where: { userId: { not: null } } }),
    ]);
    return {
      items: items.map((s) => this.mapSubscription(s)),
      total,
    };
  }

  async setUserPlan(
    actorId: string,
    userId: string,
    plan: string,
    limitsJson: string | null | undefined,
    manualOverride: boolean,
  ): Promise<AdminSubscriptionModel> {
    // Validate plan tier
    const validPlans: string[] = ['SOLO', 'SIGNAL', 'FLEET'];
    if (!validPlans.includes(plan)) {
      throw new BadRequestException('Invalid plan tier');
    }
    const validatedPlan = plan as PlanTier;

    const parsedLimits = parseAdminLimits(limitsJson);

    const subscription = await this.prisma.$transaction(async (tx) => {
      await this.entitlements.lockUsers(tx, [userId]);
      const account = await tx.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (!account) throw new NotFoundException('User not found');

      const before = await tx.subscription.findUnique({
        where: { userId },
        select: { plan: true, limits: true, manualOverride: true },
      });
      const updated = await tx.subscription.upsert({
        where: { userId },
        update: {
          plan: validatedPlan,
          limits: parsedLimits ?? Prisma.DbNull,
          manualOverride,
        },
        create: {
          userId,
          plan: validatedPlan,
          limits: parsedLimits ?? Prisma.DbNull,
          manualOverride,
        },
      });
      await tx.user.update({
        where: { id: userId },
        data: { billingStateVersion: { increment: 1 } },
      });
      await tx.auditLog.create({
        data: {
          actorUserId: actorId,
          action: 'user.setPlan',
          targetType: 'user',
          targetId: userId,
          metadata: {
            before: {
              plan: before?.plan ?? null,
              limits: before?.limits ?? null,
              manualOverride: before?.manualOverride ?? false,
            },
            after: {
              plan: validatedPlan,
              limits: parsedLimits ?? null,
              manualOverride,
            },
          },
        },
      });
      return { ...updated, user: account };
    });
    return this.mapSubscription(subscription);
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────────

  async getMetrics(): Promise<AdminMetrics> {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalOrgs,
      totalProjects,
      totalChecks,
      checksByStatusRaw,
      recentSignupsRaw,
      signupDatesRaw,
      alertsLast24h,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.organization.count(),
      this.prisma.project.count(),
      this.prisma.check.count(),
      this.prisma.check.groupBy({ by: ['status'], _count: { status: true } }),
      this.prisma.user.findMany({
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, email: true, createdAt: true },
      }),
      this.prisma.user.findMany({
        select: { createdAt: true },
        where: { createdAt: { gte: fourteenDaysAgo } },
      }),
      this.prisma.alertLog.count({
        where: { sentAt: { gte: twentyFourHoursAgo } },
      }),
    ]);

    // Aggregate signups by day (YYYY-MM-DD) in JS
    const dayMap = new Map<string, number>();
    for (const { createdAt } of signupDatesRaw) {
      const day = createdAt.toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
    }
    const signupsPerDay = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, count]) => ({ day, count }));

    return {
      totalUsers,
      totalOrgs,
      totalProjects,
      totalChecks,
      checksByStatus: checksByStatusRaw.map((r) => ({
        status: r.status,
        count: r._count.status,
      })),
      recentSignups: recentSignupsRaw.map((u) => ({
        id: u.id,
        email: u.email,
        createdAt: u.createdAt,
      })),
      signupsPerDay,
      alertsLast24h,
    };
  }

  // ─── Mappers ──────────────────────────────────────────────────────────────────

  private mapUser(u: {
    id: string;
    email: string;
    isAdmin: boolean;
    suspendedAt: Date | null;
    createdAt: Date;
    memberships: Array<{
      role: string;
      organization: { id: string; name: string };
    }>;
  }): AdminUserModel {
    return {
      id: u.id,
      email: u.email,
      isAdmin: u.isAdmin,
      suspendedAt: u.suspendedAt ?? undefined,
      createdAt: u.createdAt,
      organizations: u.memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        role: m.role,
      })),
    };
  }

  private mapOrg(o: {
    id: string;
    name: string;
    createdAt: Date;
    memberships: Array<{ role: string; user: { id: string; email: string } }>;
    projects: Array<{ id: string }>;
    creator: { subscription: { plan: string } | null };
  }): AdminOrganizationModel {
    return {
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      members: o.memberships.map((m) => ({
        userId: m.user.id,
        email: m.user.email,
        role: m.role,
      })),
      projectCount: o.projects.length,
      plan: o.creator.subscription?.plan ?? 'SOLO',
    };
  }

  private mapProject(p: {
    id: string;
    name: string;
    organizationId: string;
    organization: { id: string; name: string };
    createdAt: Date;
    _count: { checks: number };
  }): AdminProjectModel {
    return {
      id: p.id,
      name: p.name,
      organizationId: p.organization.id,
      organizationName: p.organization.name,
      checkCount: p._count.checks,
      createdAt: p.createdAt,
    };
  }

  private mapSubscription(s: {
    id: string;
    userId: string | null;
    user: { email: string } | null;
    plan: string;
    status: string;
    manualOverride: boolean;
    limits: Prisma.JsonValue;
    stripeSubscriptionId: string | null;
    createdAt: Date;
  }): AdminSubscriptionModel {
    return {
      id: s.id,
      userId: s.userId ?? '',
      userEmail: s.user?.email ?? '',
      plan: s.plan,
      status: s.status,
      manualOverride: s.manualOverride,
      limitsJson: s.limits != null ? JSON.stringify(s.limits) : undefined,
      stripeSubscriptionId: s.stripeSubscriptionId ?? undefined,
      createdAt: s.createdAt,
    };
  }

  private mapCheck(c: {
    id: string;
    name: string;
    type: string;
    status: string;
    projectId: string;
    project: {
      id: string;
      name: string;
      organization: { id: string; name: string };
    };
  }): AdminCheckModel {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      projectId: c.project.id,
      projectName: c.project.name,
      organizationId: c.project.organization.id,
      organizationName: c.project.organization.name,
    };
  }

  private mapAuditLog(log: {
    id: string;
    actorUserId: string;
    actor: { email: string };
    action: string;
    targetType: string | null;
    targetId: string | null;
    createdAt: Date;
  }): AuditLogModel {
    return {
      id: log.id,
      actorUserId: log.actorUserId,
      actorEmail: log.actor.email,
      action: log.action,
      targetType: log.targetType ?? undefined,
      targetId: log.targetId ?? undefined,
      createdAt: log.createdAt,
    };
  }
}
