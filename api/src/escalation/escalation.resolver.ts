import { Args, ID, Mutation, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { JwtUser } from '../auth/jwt.strategy';
import { EscalationService } from './escalation.service';
import { EscalationPolicyModel } from './escalation.model';

@Resolver(() => EscalationPolicyModel)
@UseGuards(ApiAuthGuard)
export class EscalationResolver {
  constructor(private readonly escalationService: EscalationService) {}

  @Query(() => [EscalationPolicyModel])
  escalationPolicies(
    @CurrentUser() user: JwtUser,
    @Args('projectId', { type: () => ID }) projectId: string,
  ) {
    return this.escalationService.list(user.userId, projectId);
  }

  @Mutation(() => EscalationPolicyModel)
  createEscalationPolicy(
    @CurrentUser() user: JwtUser,
    @Args('projectId', { type: () => ID }) projectId: string,
    @Args('stepsJson') stepsJson: string,
  ) {
    return this.escalationService.create(user.userId, projectId, stepsJson);
  }

  @Mutation(() => EscalationPolicyModel)
  updateEscalationPolicy(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
    @Args('stepsJson') stepsJson: string,
  ) {
    return this.escalationService.update(user.userId, id, stepsJson);
  }

  @Mutation(() => Boolean)
  deleteEscalationPolicy(
    @CurrentUser() user: JwtUser,
    @Args('id', { type: () => ID }) id: string,
  ) {
    return this.escalationService.delete(user.userId, id);
  }

  @Mutation(() => Boolean)
  acknowledgeCheck(
    @CurrentUser() user: JwtUser,
    @Args('checkId', { type: () => ID }) checkId: string,
  ) {
    return this.escalationService.acknowledgeCheck(user.userId, checkId);
  }
}
