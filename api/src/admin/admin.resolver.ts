import { Args, ID, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { AdminGuard } from './admin.guard';
import { AdminService } from './admin.service';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import {
  AdminUserModel,
  AdminUserList,
  AdminOrganizationModel,
  AdminOrgList,
  AdminProjectList,
  AdminCheckList,
  AdminCheckModel,
  AdminSubscriptionList,
  AdminSubscriptionModel,
  AdminMetrics,
  ImpersonationResult,
  AuditLogList,
} from './admin.model';

@Resolver()
@UseGuards(ApiAuthGuard, AdminGuard)
export class AdminResolver {
  constructor(private readonly adminService: AdminService) {}

  @Query(() => String)
  adminPing(): string {
    return 'ok';
  }

  // ─── Metrics ──────────────────────────────────────────────────────────────────

  @Query(() => AdminMetrics)
  async adminMetrics(): Promise<AdminMetrics> {
    return this.adminService.getMetrics();
  }

  // ─── Users ────────────────────────────────────────────────────────────────────

  @Query(() => AdminUserList)
  async adminUsers(
    @Args('search', { nullable: true }) search?: string,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<AdminUserList> {
    return this.adminService.users(search, page ?? 0, pageSize ?? 25);
  }

  @Query(() => AdminUserModel)
  async adminUser(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AdminUserModel> {
    return this.adminService.user(id);
  }

  @Mutation(() => AdminUserModel)
  async adminSuspendUser(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AdminUserModel> {
    return this.adminService.suspendUser(user.userId, id);
  }

  @Mutation(() => AdminUserModel)
  async adminUnsuspendUser(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AdminUserModel> {
    return this.adminService.unsuspendUser(user.userId, id);
  }

  @Mutation(() => AdminUserModel)
  async adminSetUserAdmin(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
    @Args('isAdmin') isAdmin: boolean,
  ): Promise<AdminUserModel> {
    return this.adminService.setUserAdmin(user.userId, id, isAdmin);
  }

  @Mutation(() => Boolean)
  async adminDeleteUser(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.adminService.deleteUser(user.userId, id);
  }

  // ─── Impersonation ────────────────────────────────────────────────────────────

  @Mutation(() => ImpersonationResult)
  async adminImpersonate(
    @CurrentUser() user: JwtUser,
    @Args('userId', { type: () => ID }) userId: string,
  ): Promise<ImpersonationResult> {
    return this.adminService.impersonate(user.userId, userId);
  }

  // ─── Audit Log ────────────────────────────────────────────────────────────────

  @Query(() => AuditLogList)
  async adminAuditLog(
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<AuditLogList> {
    return this.adminService.auditLog(page ?? 0, pageSize ?? 25);
  }

  // ─── Organizations ────────────────────────────────────────────────────────────

  @Query(() => AdminOrgList)
  async adminOrganizations(
    @Args('search', { nullable: true }) search?: string,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<AdminOrgList> {
    return this.adminService.organizations(search, page ?? 0, pageSize ?? 25);
  }

  @Query(() => AdminOrganizationModel)
  async adminOrganization(
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AdminOrganizationModel> {
    return this.adminService.organization(id);
  }

  @Mutation(() => Boolean)
  async adminDeleteOrganization(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.adminService.deleteOrganization(user.userId, id);
  }

  // ─── Projects ─────────────────────────────────────────────────────────────────

  @Query(() => AdminProjectList)
  async adminProjects(
    @Args('search', { nullable: true }) search?: string,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<AdminProjectList> {
    return this.adminService.projects(search, page ?? 0, pageSize ?? 25);
  }

  // ─── Checks ───────────────────────────────────────────────────────────────────

  @Query(() => AdminCheckList)
  async adminChecks(
    @Args('status', { nullable: true }) status?: string,
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<AdminCheckList> {
    return this.adminService.checks(status, page ?? 0, pageSize ?? 25);
  }

  @Mutation(() => AdminCheckModel)
  async adminPauseCheck(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AdminCheckModel> {
    return this.adminService.pauseCheck(user.userId, id);
  }

  @Mutation(() => AdminCheckModel)
  async adminResumeCheck(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<AdminCheckModel> {
    return this.adminService.resumeCheck(user.userId, id);
  }

  @Mutation(() => Boolean)
  async adminDeleteCheck(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ): Promise<boolean> {
    return this.adminService.deleteCheck(user.userId, id);
  }

  // ─── Subscriptions ────────────────────────────────────────────────────────────

  @Query(() => AdminSubscriptionList)
  async adminSubscriptions(
    @Args('page', { type: () => Int, nullable: true }) page?: number,
    @Args('pageSize', { type: () => Int, nullable: true }) pageSize?: number,
  ): Promise<AdminSubscriptionList> {
    return this.adminService.subscriptions(page ?? 0, pageSize ?? 25);
  }

  @Mutation(() => AdminSubscriptionModel)
  async adminSetUserPlan(
    @CurrentUser() user: JwtUser,
    @Args('userId', { type: () => ID }) userId: string,
    @Args('plan') plan: string,
    @Args('limitsJson', { nullable: true }) limitsJson?: string,
    @Args('manualOverride', { nullable: true }) manualOverride?: boolean,
  ): Promise<AdminSubscriptionModel> {
    return this.adminService.setUserPlan(
      user.userId,
      userId,
      plan,
      limitsJson,
      manualOverride ?? true,
    );
  }
}
