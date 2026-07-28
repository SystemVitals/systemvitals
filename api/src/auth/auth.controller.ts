import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthService } from './auth.service';
import type { GoogleIdentity } from './auth.service';
import { CredentialsDto, LoginDto } from './dto';
import { GoogleAuthGuard } from './google-auth.guard';
import {
  GOOGLE_AUTH_HANDLER_NAME,
  GOOGLE_CALLBACK_HANDLER_NAME,
} from './google-auth-handlers';

@UseGuards(ThrottlerGuard)
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cfg: ConfigService,
  ) {}

  private appUrl(): string {
    return this.cfg.get<string>('APP_URL') ?? 'http://localhost:9999';
  }

  @Post('signup')
  signup(@Body() dto: CredentialsDto) {
    return this.auth.signup(dto.email, dto.password);
  }

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /** Kicks off the OAuth redirect; passport handles the response. */
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  googleAuth(): void {
    // Intentionally empty.
  }

  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  async googleCallback(
    @Req() req: FastifyRequest & { user?: GoogleIdentity },
    @Res() res: FastifyReply,
  ): Promise<void> {
    const failure = `${this.appUrl()}/login?error=google`;
    if (!req.user) {
      await res.redirect(failure, 302);
      return;
    }
    try {
      const { token } = await this.auth.loginWithGoogle(req.user);
      await res.redirect(
        `${this.appUrl()}/auth/callback?token=${encodeURIComponent(token)}`,
        302,
      );
    } catch {
      // Unverified email, suspended account, or a database failure. The browser
      // gets one generic outcome; details stay server-side.
      await res.redirect(failure, 302);
    }
  }
}

// Fails fast at module-load time (app boot, or simply importing this file in
// a test) if either method above is ever renamed without updating the
// shared constant GoogleAuthGuard depends on for routing — turning a silent
// divergence (guard 404s or mis-routes with no compiler error) into an
// immediate, loud one.
if (AuthController.prototype.googleAuth.name !== GOOGLE_AUTH_HANDLER_NAME) {
  throw new Error(
    'AuthController.googleAuth was renamed without updating GOOGLE_AUTH_HANDLER_NAME in google-auth-handlers.ts',
  );
}
if (
  AuthController.prototype.googleCallback.name !== GOOGLE_CALLBACK_HANDLER_NAME
) {
  throw new Error(
    'AuthController.googleCallback was renamed without updating GOOGLE_CALLBACK_HANDLER_NAME in google-auth-handlers.ts',
  );
}
