import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ApiAuthGuard } from './api-auth.guard';
import { ApiTokenStrategy } from './api-token.strategy';
import { TokensService } from './tokens.service';
import { WorkspacesModule } from '../workspaces/workspaces.module';

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
  providers: [TokensService, ApiTokenStrategy, ApiAuthGuard],
  exports: [TokensService, ApiAuthGuard],
})
export class TokensCoreModule {}
