import { Field, ID, Int, ObjectType } from '@nestjs/graphql';

// ─── Metrics ──────────────────────────────────────────────────────────────────

@ObjectType()
export class StatusCount {
  @Field() status!: string;
  @Field(() => Int) count!: number;
}

@ObjectType()
export class AdminUserRef {
  @Field(() => ID) id!: string;
  @Field() email!: string;
  @Field() createdAt!: Date;
}

@ObjectType()
export class DayCount {
  @Field() day!: string; // YYYY-MM-DD
  @Field(() => Int) count!: number;
}

@ObjectType()
export class AdminMetrics {
  @Field(() => Int) totalUsers!: number;
  @Field(() => Int) totalOrgs!: number;
  @Field(() => Int) totalProjects!: number;
  @Field(() => Int) totalChecks!: number;
  @Field(() => [StatusCount]) checksByStatus!: StatusCount[];
  @Field(() => [AdminUserRef]) recentSignups!: AdminUserRef[];
  @Field(() => [DayCount]) signupsPerDay!: DayCount[];
  @Field(() => Int) alertsLast24h!: number;
}

@ObjectType()
export class AdminOrgRef {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() role!: string;
}

// ─── Projects ─────────────────────────────────────────────────────────────────

@ObjectType()
export class AdminProjectModel {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field(() => ID) organizationId!: string;
  @Field() organizationName!: string;
  @Field(() => Int) checkCount!: number;
  @Field() createdAt!: Date;
}

@ObjectType()
export class AdminProjectList {
  @Field(() => [AdminProjectModel]) items!: AdminProjectModel[];
  @Field(() => Int) total!: number;
}

// ─── Checks ───────────────────────────────────────────────────────────────────

@ObjectType()
export class AdminCheckModel {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() type!: string;
  @Field() status!: string;
  @Field(() => ID) projectId!: string;
  @Field() projectName!: string;
  @Field(() => ID) organizationId!: string;
  @Field() organizationName!: string;
}

@ObjectType()
export class AdminCheckList {
  @Field(() => [AdminCheckModel]) items!: AdminCheckModel[];
  @Field(() => Int) total!: number;
}

@ObjectType()
export class AdminUserModel {
  @Field(() => ID) id!: string;
  @Field() email!: string;
  @Field() isAdmin!: boolean;
  @Field({ nullable: true }) suspendedAt?: Date;
  @Field() createdAt!: Date;
  @Field(() => [AdminOrgRef]) organizations!: AdminOrgRef[];
}

@ObjectType()
export class AdminUserList {
  @Field(() => [AdminUserModel]) items!: AdminUserModel[];
  @Field(() => Int) total!: number;
}

@ObjectType()
export class AdminMemberRef {
  @Field(() => ID) userId!: string;
  @Field() email!: string;
  @Field() role!: string;
}

@ObjectType()
export class AdminOrganizationModel {
  @Field(() => ID) id!: string;
  @Field() name!: string;
  @Field() createdAt!: Date;
  @Field(() => [AdminMemberRef]) members!: AdminMemberRef[];
  @Field(() => Int) projectCount!: number;
  @Field({ nullable: true }) plan?: string;
}

@ObjectType()
export class AdminOrgList {
  @Field(() => [AdminOrganizationModel]) items!: AdminOrganizationModel[];
  @Field(() => Int) total!: number;
}

// ─── Impersonation ────────────────────────────────────────────────────────────

@ObjectType()
export class ImpersonationResult {
  @Field() token!: string;
  @Field() expiresAt!: Date;
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

@ObjectType()
export class AuditLogModel {
  @Field(() => ID) id!: string;
  @Field() actorUserId!: string;
  @Field() actorEmail!: string;
  @Field() action!: string;
  @Field({ nullable: true }) targetType?: string;
  @Field({ nullable: true }) targetId?: string;
  @Field() createdAt!: Date;
}

@ObjectType()
export class AuditLogList {
  @Field(() => [AuditLogModel]) items!: AuditLogModel[];
  @Field(() => Int) total!: number;
}

// ─── Subscriptions ─────────────────────────────────────────────────────────────

@ObjectType()
export class AdminSubscriptionModel {
  @Field(() => ID) id!: string;
  @Field(() => ID) userId!: string;
  @Field() userEmail!: string;
  @Field() plan!: string;
  @Field() status!: string;
  @Field() manualOverride!: boolean;
  @Field({ nullable: true }) limitsJson?: string;
  @Field({ nullable: true }) stripeSubscriptionId?: string;
  @Field() createdAt!: Date;
}

@ObjectType()
export class AdminSubscriptionList {
  @Field(() => [AdminSubscriptionModel]) items!: AdminSubscriptionModel[];
  @Field(() => Int) total!: number;
}
