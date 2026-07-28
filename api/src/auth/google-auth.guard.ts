import {
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthGuard } from '@nestjs/passport';
import type { Observable } from 'rxjs';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { GoogleIdentity } from './auth.service';
import { GOOGLE_AUTH_HANDLER_NAME } from './google-auth-handlers';
import {
  buildClearStateCookieHeader,
  buildStateCookieHeader,
  generateNonce,
  signNonce,
  verifyState as verifyOAuthState,
} from './oauth-state';

/** The subset of Node's raw response this guard actually calls. */
interface RawResponse {
  setHeader(name: string, value: string): void;
}

/**
 * Wraps the passport 'google' strategy so that:
 *  - the routes behave as if they do not exist unless GOOGLE_CLIENT_ID,
 *    GOOGLE_CLIENT_SECRET and GOOGLE_CALLBACK_URL are ALL configured — this
 *    guard is the single request-time gate. GoogleStrategy is always
 *    registered (with inert dummy credentials when unconfigured, see
 *    google.strategy.ts) so it can never crash boot; whether the routes are
 *    actually reachable is decided here, by reading the same ConfigService
 *    the strategy would use, so the two can never diverge.
 *  - OAuth failures resolve to a null user instead of a 401 JSON body, letting
 *    the controller redirect the browser somewhere useful.
 *  - the two legs are bound together by a signed nonce (Task 4b), closing a
 *    login-CSRF hole: see oauth-state.ts for the crypto and why it lives
 *    there rather than behind passport-oauth2's state-store option.
 */
@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  constructor(private readonly cfg: ConfigService) {
    super();
  }

  private isConfigured(): boolean {
    return Boolean(
      this.cfg.get<string>('GOOGLE_CLIENT_ID') &&
      this.cfg.get<string>('GOOGLE_CLIENT_SECRET') &&
      this.cfg.get<string>('GOOGLE_CALLBACK_URL'),
    );
  }

  /**
   * Both routes share this guard class, so it has to tell them apart to know
   * whether to mint a new state nonce or verify one. The handler's method
   * name is a stable, always-available signal — AuthController's two routes
   * always dispatch to `googleAuth` and `googleCallback` respectively.
   * GOOGLE_AUTH_HANDLER_NAME is the single source of truth for that literal
   * (shared with this guard's spec) so a method rename on AuthController is
   * a one-line grep instead of a silent divergence.
   */
  private isAuthorizeRoute(context: ExecutionContext): boolean {
    return context.getHandler().name === GOOGLE_AUTH_HANDLER_NAME;
  }

  /** Local dev runs over http://localhost; a Secure cookie would never reach
   *  the browser there. Every other environment (test, production) gets it. */
  private isSecureCookie(): boolean {
    return process.env.NODE_ENV !== 'development';
  }

  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    if (!this.isConfigured()) {
      throw new NotFoundException();
    }
    if (!this.isAuthorizeRoute(context)) {
      return this.canActivateCallback(context);
    }
    return super.canActivate(context);
  }

  /**
   * Called by @nestjs/passport's AuthGuard.canActivate (see getResponse()'s
   * doc-comment below) before it invokes passport, on both routes. Only the
   * authorize leg needs to do anything: mint the nonce, sign it into the
   * state cookie — written straight to the RAW response, since Fastify-level
   * cookie APIs never flush on this leg — and hand the plaintext nonce back
   * as the `state` authenticate() option so passport-oauth2's redirect
   * carries it as a query parameter.
   */
  getAuthenticateOptions(
    context: ExecutionContext,
  ): { state: string } | undefined {
    if (!this.isAuthorizeRoute(context)) return undefined;

    const nonce = generateNonce();
    const jwtSecret = this.cfg.getOrThrow<string>('JWT_SECRET');
    const signedCookie = signNonce(jwtSecret, nonce);
    const raw = this.getResponse(context) as RawResponse;
    raw.setHeader(
      'Set-Cookie',
      buildStateCookieHeader(signedCookie, this.isSecureCookie()),
    );
    return { state: nonce };
  }

  /**
   * The callback leg. passport-oauth2's own state verification is a no-op
   * here — it checks against a strategy-level store fixed at construction
   * time (see google.strategy.ts), not against this request's cookie — so
   * the nonce comparison happens here, before passport is allowed to
   * exchange the code with Google. On every outcome the cookie is cleared
   * via the normal Fastify reply; this leg never hits the raw-response trap
   * (passport's success/fail paths resolve through the callback
   * @nestjs/passport supplies, they never touch `res` directly).
   */
  private canActivateCallback(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();

    reply.header(
      'Set-Cookie',
      buildClearStateCookieHeader(this.isSecureCookie()),
    );

    if (this.verifyState(req)) {
      return super.canActivate(context);
    }
    (req as FastifyRequest & { user?: GoogleIdentity | null }).user = null;
    return true;
  }

  /**
   * Delegates to oauth-state.ts's exported `verifyState` — see that
   * function's doc-comment for why the actual comparison logic lives there
   * as a plain, directly-testable function rather than inlined here.
   */
  private verifyState(req: FastifyRequest): boolean {
    const jwtSecret = this.cfg.getOrThrow<string>('JWT_SECRET');
    return verifyOAuthState(
      req.headers.cookie,
      this.queryState(req),
      jwtSecret,
    );
  }

  private queryState(req: FastifyRequest): string | null {
    const query = req.query;
    if (query && typeof query === 'object' && 'state' in query) {
      const value = (query as Record<string, unknown>).state;
      if (typeof value === 'string') return value;
    }
    return null;
  }

  /**
   * @nestjs/passport's AuthGuard.canActivate hands passport whatever
   * getResponse(context) returns (node_modules/@nestjs/passport/dist/auth.guard.js).
   * Passport's redirect path calls `res.setHeader(...)` / `res.end()` directly
   * (node_modules/passport/lib/middleware/authenticate.js) — methods Fastify's
   * reply wrapper does not implement (`FastifyReply.setHeader`/`.end` are
   * `undefined`). Handing it the raw Node response instead lets the redirect
   * actually reach the client. This applies to both routes, but only matters
   * for the authorize leg in practice — the callback leg's success/fail paths
   * never call methods on `res` directly (see canActivateCallback above).
   */
  getResponse(context: ExecutionContext): unknown {
    return context.switchToHttp().getResponse<FastifyReply>().raw;
  }

  handleRequest<TUser = GoogleIdentity>(err: unknown, user: unknown): TUser {
    if (err || !user) return null as TUser;
    return user as TUser;
  }
}
