import { Module } from '@nestjs/common';
import { OverviewResolver } from './overview.resolver';
import { OverviewService } from './overview.service';

@Module({
  providers: [OverviewResolver, OverviewService],
})
export class OverviewModule {}
