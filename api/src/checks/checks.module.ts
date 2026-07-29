import { Module } from '@nestjs/common';
import { ChecksService } from './checks.service';
import { ChecksResolver } from './checks.resolver';
import { BillingModule } from '../billing/billing.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';

@Module({
  imports: [BillingModule, WorkspacesModule],
  providers: [ChecksService, ChecksResolver],
})
export class ChecksModule {}
