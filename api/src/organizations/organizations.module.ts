import { Module } from '@nestjs/common';
import { OrganizationsResolver } from './organizations.resolver';
import { OrganizationsService } from './organizations.service';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [BillingModule],
  providers: [OrganizationsResolver, OrganizationsService],
})
export class OrganizationsModule {}
