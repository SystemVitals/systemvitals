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
import { ChecksService } from './checks.service';
import { CheckModel, CheckEventModel } from './check.model';
import { UpdateCheckInput } from './update-check.input';
import { nextCronFire } from './cron';

@Resolver(() => CheckModel)
@UseGuards(ApiAuthGuard)
export class ChecksResolver {
  constructor(private readonly checksService: ChecksService) {}

  @Query(() => [CheckModel])
  checks(
    @CurrentUser() principal: ApiPrincipal,
    @Args('projectId', { type: () => ID }) projectId: string,
  ) {
    requireCheckAccess(principal, 'checks:read', projectId);
    return this.checksService.list(principal.userId, projectId);
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
    return check;
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
  createCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('name') name: string,
    @Args('graceSeconds', { type: () => Int }) graceSeconds: number,
    @Args('periodSeconds', { type: () => Int, nullable: true })
    periodSeconds?: number,
    @Args('schedule', { nullable: true }) schedule?: string,
    @Args('tz', { nullable: true }) tz?: string,
  ) {
    requireCheckAccess(principal, 'checks:write', projectId);
    return this.checksService.create(
      principal.userId,
      projectId,
      name,
      graceSeconds,
      periodSeconds,
      schedule,
      tz,
    );
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
    return this.checksService.update(principal.userId, id, projectId, input);
  }

  @Mutation(() => CheckModel)
  @AccountSessionOnly()
  moveCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('checkId', { type: () => ID }) checkId: string,
    @Args('destinationProjectId', { type: () => ID })
    destinationProjectId: string,
  ) {
    return this.checksService.move(
      principal.userId,
      checkId,
      destinationProjectId,
    );
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
    return this.checksService.pause(principal.userId, id, projectId);
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
    return this.checksService.resume(principal.userId, id, projectId);
  }

  @Mutation(() => CheckModel)
  createActiveCheck(
    @CurrentUser() principal: ApiPrincipal,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('name') name: string,
    @Args('type') type: string,
    @Args('target') target: string,
    @Args('intervalSeconds', { type: () => Int }) intervalSeconds: number,
    @Args('timeoutMs', { type: () => Int }) timeoutMs: number,
    @Args('method', { nullable: true }) method?: string,
    @Args('expectedStatus', { type: () => Int, nullable: true })
    expectedStatus?: number,
  ) {
    requireCheckAccess(principal, 'checks:write', projectId);
    return this.checksService.createActiveCheck(
      principal.userId,
      projectId,
      name,
      type,
      target,
      intervalSeconds,
      timeoutMs,
      method,
      expectedStatus,
    );
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
