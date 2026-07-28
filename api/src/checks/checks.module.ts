import { Module } from '@nestjs/common';
import { ChecksService } from './checks.service';
import { ChecksResolver } from './checks.resolver';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule],
  providers: [ChecksService, ChecksResolver],
})
export class ChecksModule {}
