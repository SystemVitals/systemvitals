import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ApiAuthGuard } from './api-auth.guard';
import { ApiTokenStrategy } from './api-token.strategy';
import { TokensService } from './tokens.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { AccountAccessGuard } from './account-access.guard';

@Module({
  imports: [
    WorkspacesModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  providers: [
    TokensService,
    ApiTokenStrategy,
    ApiAuthGuard,
    AccountAccessGuard,
  ],
  exports: [TokensService, ApiAuthGuard, AccountAccessGuard],
})
export class TokensCoreModule {}
