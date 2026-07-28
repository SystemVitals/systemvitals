import { Module } from '@nestjs/common';
import { TokensCoreModule } from '../tokens/tokens-core.module';
import { AuthModule } from '../auth/auth.module';
import { AdminGuard } from './admin.guard';
import { AdminResolver } from './admin.resolver';
import { AdminService } from './admin.service';
import { AdminBootstrapService } from './admin-bootstrap.service';
import { AccountEntitlementsService } from '../billing/account-entitlements.service';

@Module({
  imports: [TokensCoreModule, AuthModule],
  providers: [
    AdminGuard,
    AdminResolver,
    AdminService,
    AdminBootstrapService,
    AccountEntitlementsService,
  ],
})
export class AdminModule {}
