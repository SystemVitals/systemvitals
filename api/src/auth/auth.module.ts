import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './jwt.strategy';
import { GoogleStrategy } from './google.strategy';
import { NonImpersonatedSessionGuard } from './account-session.guard';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      useFactory: (cfg: ConfigService) => ({
        secret: cfg.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '30d' },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    // Always registered — see google.strategy.ts for why partial/absent
    // config is tolerated here. GoogleAuthGuard is what actually gates the
    // routes (404s them unless Google is fully configured), evaluated at
    // request time via ConfigService so it can never diverge from this.
    GoogleStrategy,
    JwtAuthGuard,
    NonImpersonatedSessionGuard,
  ],
  exports: [AuthService, JwtAuthGuard, NonImpersonatedSessionGuard],
})
export class AuthModule {}
