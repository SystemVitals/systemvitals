import { Args, Query, Resolver } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { ApiAuthGuard } from '../tokens/api-auth.guard';
import { CurrentUser } from '../common/current-user.decorator';
import type { ApiPrincipal } from '../tokens/api-principal';
import {
  AccountOverview,
  OverviewRange,
} from './models/account-overview.model';
import { OverviewService } from './overview.service';

@Resolver(() => AccountOverview)
@UseGuards(ApiAuthGuard)
export class OverviewResolver {
  constructor(private readonly overviewService: OverviewService) {}

  @Query(() => AccountOverview)
  accountOverview(
    @CurrentUser() principal: ApiPrincipal,
    @Args('range', { type: () => OverviewRange }) range: OverviewRange,
    @Args('timeZone', { nullable: true }) timeZone?: string,
  ): Promise<AccountOverview> {
    return this.overviewService.accountOverview(
      principal.userId,
      range,
      timeZone,
    );
  }
}
