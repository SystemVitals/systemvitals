import {
  Args,
  ID,
  Int,
  Mutation,
  Parent,
  Query,
  ResolveField,
  Resolver,
} from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { AccountSessionOnly } from '../auth/account-session.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { ApiPrincipal } from '../tokens/api-principal';
import { requireCheckAccess } from '../tokens/token-policy';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { ChecksService } from './checks.service';
import { CheckModel, CheckEventModel } from './check.model';
import { UpdateCheckInput } from './update-check.input';
import { nextCronFire } from './cron';

@Resolver(() => CheckModel)
@UseGuards(ApiAuthGuard)
export class ChecksResolver {
  constructor(
    private readonly checksService: ChecksService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  private attachOrganization<T extends object>(
    value: T,
    organizationId: string,
  ): T & { organizationId: string } {
    return { ...value, organizationId };
  }

  @Query(() => [CheckModel])
  async checks(
    @CurrentUser() principal: ApiPrincipal,
    @Args('organizationId', { type: () => ID, nullable: true })
    organizationId?: string,
    @Args('projectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use organizationId.',
    })
    projectId?: string,
  ) {
    const workspace = await this.workspacesService.resolveForUser(
      principal.userId,
      { organizationId, projectId },
    );
    requireCheckAccess(principal, 'checks:read', workspace.projectId);
    const checks = await this.checksService.list(
      principal.userId,
      workspace.projectId,
    );
    return checks.map((check) =>
      this.attachOrganization(check, workspace.organizationId),
    );
  }

  @Query(() => CheckModel)
  async check(
    @CurrentUser() principal: ApiPrincipal,
    @Args('id', { type: () => ID }) id: string,
  ) {
    const check = await this.checksService.findOne(principal.userId, id);
    requireCheckAccess(principal, 'checks:read', check.projectId);
    return check;
  }

  @Query(() => CheckModel)
  async checkByOrganizationSlug(
    @CurrentUser() principal: ApiPrincipal,
    @Args('orgSlug') orgSlug: string,
    @Args('checkSlug') checkSlug: string,
  ) {
    const check = await this.checksService.findByOrganizationSlug(
      principal.userId,
      orgSlug,
      checkSlug,
    );
    requireCheckAccess(principal, 'checks:read', check.projectId);
    return check;
  }

  @Query(() => CheckModel)
  async checkBySlug(
    @CurrentUser() principal: ApiPrincipal,
    @Args('orgSlug') orgSlug: string,
    @Args('projectSlug') projectSlug: string,
    @Args('checkSlug') checkSlug: string,
  ) {
    const check = await this.checksService.findBySlug(
      principal.userId,
      orgSlug,
      projectSlug,
      checkSlug,
    );
    requireCheckAccess(principal, 'checks:read', check.projectId);
    const organizationId =
      await this.workspacesService.resolveOrganizationForProject(
        check.projectId,
      );
    return this.attachOrganization(check, organizationId);
  }

  @ResolveField(() => [CheckEventModel])
  events(
    @CurrentUser() principal: ApiPrincipal,
    @Parent() check: CheckModel,
    @Args('limit', { type: () => Int, defaultValue: 50 }) limit: number,
  ) {
    requireCheckAccess(principal, 'checks:read', check.projectId);
    return this.checksService.eventsForCheck(check.id, limit);
  }

  @ResolveField(() => [ID])
  notificationChannelIds(@Parent() check: CheckModel) {
    if (check.notificationChannelIds) return check.notificationChannelIds;
    return this.checksService.effectiveNotificationChannelIds(
      check.id,
      check.projectId,
    );
  }

  @ResolveField(() => Date, { nullable: true })
  nextExpectedAt(@Parent() check: CheckModel): Date | null {
    const c = check as unknown as {
      schedule?: string | null;
      tz?: string | null;
      periodSeconds?: number | null;
      lastEventAt?: Date | null;
    };
    const anchor = c.lastEventAt ?? null;
    if (c.schedule) {
      return nextCronFire(c.schedule, c.tz ?? 'UTC', anchor ?? new Date());
    }
    if (c.periodSeconds != null && anchor) {
      return new Date(anchor.getTime() + c.periodSeconds * 1000);
    }
    return null;
  }

  @Mutation(() => CheckModel)
  async createCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('organizationId', { type: () => ID, nullable: true })
    organizationId: string | undefined,
    @Args('projectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use organizationId.',
    })
    projectId: string | undefined,
    @Args('name') name: string,
    @Args('graceSeconds', { type: () => Int }) graceSeconds: number,
    @Args('periodSeconds', { type: () => Int, nullable: true })
    periodSeconds?: number,
    @Args('schedule', { nullable: true }) schedule?: string,
    @Args('tz', { nullable: true }) tz?: string,
  ) {
    const workspace = await this.workspacesService.resolveForUser(
      principal.userId,
      { organizationId, projectId },
    );
    requireCheckAccess(principal, 'checks:write', workspace.projectId);
    const check = await this.checksService.create(
      principal.userId,
      workspace.projectId,
      name,
      graceSeconds,
      periodSeconds,
      schedule,
      tz,
    );
    return this.attachOrganization(check, workspace.organizationId);
  }

  @Mutation(() => CheckModel)
  async updateCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('id', { type: () => ID }) id: string,
    @Args('input') input: UpdateCheckInput,
  ) {
    const projectId = await this.checksService.projectIdForCheck(
      principal.userId,
      id,
    );
    requireCheckAccess(principal, 'checks:write', projectId);
    const organizationId =
      await this.workspacesService.resolveOrganizationForProject(projectId);
    const check = await this.checksService.update(
      principal.userId,
      id,
      projectId,
      input,
    );
    return this.attachOrganization(check, organizationId);
  }

  @Mutation(() => CheckModel)
  async setCheckChannelEnabled(
    @CurrentUser() principal: ApiPrincipal,
    @Args('checkId', { type: () => ID }) checkId: string,
    @Args('channelId', { type: () => ID }) channelId: string,
    @Args('enabled', { type: () => Boolean }) enabled: boolean,
  ) {
    const projectId = await this.checksService.projectIdForCheck(
      principal.userId,
      checkId,
    );
    requireCheckAccess(principal, 'checks:write', projectId);
    const organizationId =
      await this.workspacesService.resolveOrganizationForProject(projectId);
    const check = await this.checksService.setCheckChannelEnabled(
      principal.userId,
      checkId,
      projectId,
      channelId,
      enabled,
    );
    return this.attachOrganization(check, organizationId);
  }

  @Mutation(() => CheckModel)
  @AccountSessionOnly()
  async moveCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('checkId', { type: () => ID }) checkId: string,
    @Args('destinationOrganizationId', { type: () => ID, nullable: true })
    destinationOrganizationId?: string,
    @Args('destinationProjectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use destinationOrganizationId.',
    })
    destinationProjectId?: string,
  ) {
    const destination = await this.workspacesService.resolveForUser(
      principal.userId,
      {
        organizationId: destinationOrganizationId,
        projectId: destinationProjectId,
      },
    );
    const check = await this.checksService.move(
      principal.userId,
      checkId,
      destination.projectId,
    );
    return this.attachOrganization(check, destination.organizationId);
  }

  @Mutation(() => CheckModel)
  async pauseCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('id', { type: () => ID }) id: string,
  ) {
    const projectId = await this.checksService.projectIdForCheck(
      principal.userId,
      id,
    );
    requireCheckAccess(principal, 'checks:write', projectId);
    const organizationId =
      await this.workspacesService.resolveOrganizationForProject(projectId);
    const check = await this.checksService.pause(
      principal.userId,
      id,
      projectId,
    );
    return this.attachOrganization(check, organizationId);
  }

  @Mutation(() => CheckModel)
  async resumeCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('id', { type: () => ID }) id: string,
  ) {
    const projectId = await this.checksService.projectIdForCheck(
      principal.userId,
      id,
    );
    requireCheckAccess(principal, 'checks:write', projectId);
    const organizationId =
      await this.workspacesService.resolveOrganizationForProject(projectId);
    const check = await this.checksService.resume(
      principal.userId,
      id,
      projectId,
    );
    return this.attachOrganization(check, organizationId);
  }

  @Mutation(() => CheckModel)
  async createActiveCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('organizationId', { type: () => ID, nullable: true })
    organizationId: string | undefined,
    @Args('projectId', {
      type: () => ID,
      nullable: true,
      deprecationReason: 'Use organizationId.',
    })
    projectId: string | undefined,
    @Args('name') name: string,
    @Args('type') type: string,
    @Args('target') target: string,
    @Args('intervalSeconds', { type: () => Int }) intervalSeconds: number,
    @Args('timeoutMs', { type: () => Int }) timeoutMs: number,
    @Args('method', { nullable: true }) method?: string,
    @Args('expectedStatus', { type: () => Int, nullable: true })
    expectedStatus?: number,
  ) {
    const workspace = await this.workspacesService.resolveForUser(
      principal.userId,
      { organizationId, projectId },
    );
    requireCheckAccess(principal, 'checks:write', workspace.projectId);
    const check = await this.checksService.createActiveCheck(
      principal.userId,
      workspace.projectId,
      name,
      type,
      target,
      intervalSeconds,
      timeoutMs,
      method,
      expectedStatus,
    );
    return this.attachOrganization(check, workspace.organizationId);
  }

  @Mutation(() => Boolean)
  async deleteCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('id', { type: () => ID }) id: string,
  ) {
    const projectId = await this.checksService.projectIdForCheck(
      principal.userId,
      id,
    );
    requireCheckAccess(principal, 'checks:write', projectId);
    return this.checksService.delete(principal.userId, id, projectId);
  }
}
