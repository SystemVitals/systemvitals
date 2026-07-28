import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
import type { GoogleIdentity } from './auth.service';

/**
 * Always registered (see AuthModule) so a missing or partial Google config
 * can never crash boot — mirrors billing/stripe.provider.ts's dummy-fallback
 * pattern. When unconfigured, this strategy is constructed with inert
 * placeholder credentials and is never actually reachable: GoogleAuthGuard is
 * the single request-time gate and 404s the routes unless GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL are all set.
 */
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(cfg: ConfigService) {
    const clientID = cfg.get<string>('GOOGLE_CLIENT_ID');
    const clientSecret = cfg.get<string>('GOOGLE_CLIENT_SECRET');
    const callbackURL = cfg.get<string>('GOOGLE_CALLBACK_URL');

    if (
      process.env.NODE_ENV === 'production' &&
      (!clientID || !clientSecret || !callbackURL)
    ) {
      console.warn(
        '[auth] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_CALLBACK_URL are not fully set in production — Google sign-in will be disabled',
      );
    }

    super({
      clientID: clientID || 'google-auth-disabled',
      clientSecret: clientSecret || 'google-auth-disabled',
      callbackURL:
        callbackURL || 'http://localhost/google-auth-disabled/callback',
      scope: ['email', 'profile'],
    });
  }

  validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): GoogleIdentity {
    const primary = profile.emails?.[0];
    const json = profile._json as
      | { email_verified?: boolean | string }
      | undefined;
    // Google reports verification on the raw payload as `email_verified`;
    // the normalised profile exposes it as `verified` and stringifies it.
    const emailVerified =
      json?.email_verified === true ||
      primary?.verified === true ||
      String(primary?.verified) === 'true';

    return {
      googleId: profile.id,
      email: primary?.value ?? '',
      emailVerified: emailVerified && Boolean(primary?.value),
    };
  }
}
