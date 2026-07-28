/**
 * Route-level coverage for GET /auth/google and its callback.
 *
 * Critical 1 regression: @nestjs/passport's AuthGuard hands passport
 * `getResponse(context)` (the Fastify reply wrapper by default), and
 * passport's redirect path calls `res.setHeader`/`res.end()` directly —
 * methods FastifyReply does not implement. GoogleAuthGuard now overrides
 * getResponse() to hand passport the raw Node response instead.
 *
 * Critical 2 regression: GoogleStrategy used to be registered conditionally
 * on `process.env.GOOGLE_CLIENT_ID` at @Module-decoration time — before
 * ConfigModule loads `.env` — while GoogleAuthGuard gated on ConfigService at
 * request time. Configuring Google via `.env` (not literal process.env)
 * registered no strategy while the guard still admitted requests, so
 * passport raised "Unknown authentication strategy" as a 500. GoogleStrategy
 * is now always registered (with inert dummy credentials when unconfigured)
 * and GoogleAuthGuard is the single request-time gate.
 *
 * Critical 3 (Task 4b) regression: Fastify's `reply.redirect(url, code)` only
 * defaults `code` to 302 when no status has been set on the reply yet; this
 * app's request pipeline sets one, so the callback's `res.redirect(url)`
 * calls (no explicit code) sent 200 with a Location header on every leg —
 * success and failure alike. Browsers never navigate on a 200. The tests
 * below assert the 302 contract explicitly, and a stubbed-success-path test
 * covers the token-bearing redirect too.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { buildApp } from '../src/main';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { GoogleAuthGuard } from '../src/auth/google-auth.guard';
import type { ExecutionContext, CanActivate } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import {
  OAUTH_STATE_COOKIE,
  generateNonce,
  signNonce,
  verifySignedCookie,
} from '../src/auth/oauth-state';

const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:8888/auth/google/callback',
};
const GOOGLE_KEYS = Object.keys(GOOGLE_ENV);

/** Parses a raw `Set-Cookie` header value into { name, value, attrs }. */
function parseSetCookie(header: string): {
  name: string;
  value: string;
  attrs: string[];
} {
  const [pair, ...attrs] = header.split(';').map((s) => s.trim());
  const eq = pair.indexOf('=');
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attrs };
}

/**
 * Resets the GOOGLE_* keys in process.env between describes.
 *
 * Note this alone does NOT control what the app sees. `buildApp()` runs
 * `ConfigModule.forRoot()`, which re-reads `api/.env` from disk, and the
 * file's value wins for these keys — measured directly: with
 * `process.env.GOOGLE_CLIENT_ID === ''`, `ConfigService.get()` still returned
 * the real id from the file. Any case that depends on Google being absent or
 * partially configured must therefore also call `overrideGoogleConfig()`
 * below, after the app is built.
 */
function clearGoogleEnv(): void {
  for (const key of GOOGLE_KEYS) process.env[key] = '';
}

/**
 * Forces what the running app's ConfigService reports for the GOOGLE_* keys.
 *
 * Manipulating process.env is NOT sufficient: ConfigModule merges the parsed
 * `api/.env` into its validated config, and that value wins over process.env
 * for these keys — verified directly (process.env '' but cfg.get() returning
 * the real id). ConfigService.set writes to `internalConfig`, which get()
 * consults first, so this is the only reliable way to make the
 * unconfigured/partial cases hermetic on a developer machine that has real
 * Google credentials in api/.env. Without it these two cases silently pass in
 * CI (no .env there) and fail locally.
 */
function overrideGoogleConfig(
  app: NestFastifyApplication,
  vars: Partial<Record<string, string>>,
): void {
  const cfg = app.get(ConfigService);
  for (const key of GOOGLE_KEYS) cfg.set(key, vars[key] ?? '');
}

function setGoogleEnv(vars: Partial<Record<string, string>>): void {
  clearGoogleEnv();
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
}

describe('GET /auth/google (e2e)', () => {
  describe('fully configured', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      setGoogleEnv(GOOGLE_ENV);
      app = await buildApp();
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app.close();
      clearGoogleEnv();
    });

    it('redirects (302) to accounts.google.com with a Location header', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/google' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBeDefined();
      expect(String(res.headers.location)).toMatch(
        /^https:\/\/accounts\.google\.com\//,
      );
    });

    /**
     * Task 4b, test 1: catches the raw-vs-Fastify cookie trap directly. If
     * the state cookie were set via reply.setCookie()/reply.header() instead
     * of reply.raw.setHeader(), it would be silently dropped on this route
     * (see GoogleAuthGuard's getResponse() doc-comment) and this would fail
     * with no Set-Cookie header at all.
     */
    it('sets a signed, HttpOnly, SameSite=Lax sv_oauth_state cookie whose nonce matches the redirect state param', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/google' });
      expect(res.statusCode).toBe(302);

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const { name, value, attrs } = parseSetCookie(String(header));

      expect(name).toBe(OAUTH_STATE_COOKIE);
      expect(attrs).toContain('HttpOnly');
      expect(attrs).toContain('SameSite=Lax');
      expect(attrs.some((a) => a.startsWith('Path=/auth'))).toBe(true);
      expect(attrs.some((a) => a.startsWith('Max-Age='))).toBe(true);

      const location = new URL(String(res.headers.location));
      const stateParam = location.searchParams.get('state');
      expect(stateParam).toBeTruthy();

      const jwtSecret = process.env.JWT_SECRET!;
      const nonceFromCookie = verifySignedCookie(jwtSecret, value);
      expect(nonceFromCookie).not.toBeNull();
      expect(nonceFromCookie).toBe(stateParam);
    });
  });

  describe('GET /auth/google/callback state verification (fully configured)', () => {
    let app: NestFastifyApplication;
    const APP_URL = process.env.APP_URL ?? 'http://localhost:9999';
    const failureLocation = `${APP_URL}/login?error=google`;
    // The explicit contract: every callback failure must be a real 302 to
    // failureLocation, not merely "whatever this app happens to send" — a 200
    // with a Location header is silently ignored by browsers (Task 4b
    // Critical 3). expectedBody is still captured from a real bare-denial
    // request so the uniformity assertions below have something concrete to
    // compare against, but it no longer stands in for the status check.
    let expectedStatus: number;
    let expectedBody: string;

    beforeAll(async () => {
      setGoogleEnv(GOOGLE_ENV);
      app = await buildApp();
      await app.init();
      await app.getHttpAdapter().getInstance().ready();

      const bareDenial = await app.inject({
        method: 'GET',
        url: '/auth/google/callback',
      });
      expect(bareDenial.statusCode).toBe(302);
      expect(bareDenial.headers.location).toBe(failureLocation);
      // The explicit contract, asserted directly rather than only inferred
      // from expectedBody below: a callback failure redirects with an empty
      // body. If the failure path ever started leaking a JSON error or a
      // stack trace, this line — not just the uniformity checks below, which
      // compare the app against itself — is what would catch it.
      expect(bareDenial.body).toBe('');
      expectedStatus = bareDenial.statusCode;
      expectedBody = bareDenial.body;
    });

    afterAll(async () => {
      await app.close();
      clearGoogleEnv();
    });

    /** Signs a real cookie the same way GoogleAuthGuard does, for a given nonce. */
    function realCookieFor(nonce: string): string {
      const jwtSecret = process.env.JWT_SECRET!;
      return `${OAUTH_STATE_COOKIE}=${signNonce(jwtSecret, nonce)}`;
    }

    // Test 2: no cookie at all.
    it('with no cookie, redirects to the uniform failure page', async () => {
      const state = generateNonce();
      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${state}`,
      });
      expect(res.statusCode).toBe(302);
      expect(res.statusCode).toBe(expectedStatus);
      expect(res.headers.location).toBe(failureLocation);
      expect(res.body).toBe('');
      expect(res.body).toBe(expectedBody);
    });

    // Test 3: THE actual CSRF regression test — cookie is validly signed
    // (i.e. it really is a cookie this server minted) but for a *different*
    // nonce than the one the browser is presenting as `state`. This is
    // exactly the shape of the attack in the brief: the victim's browser has
    // a real (their own) state cookie, but the attacker controls the `state`
    // query param via the URL they get the victim to open.
    it('with a validly-signed cookie for a DIFFERENT nonce than `state`, redirects to the uniform failure page', async () => {
      const cookieNonce = generateNonce();
      const attackerState = generateNonce();
      expect(attackerState).not.toBe(cookieNonce);

      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${attackerState}`,
        headers: { cookie: realCookieFor(cookieNonce) },
      });
      expect(res.statusCode).toBe(302);
      expect(res.statusCode).toBe(expectedStatus);
      expect(res.headers.location).toBe(failureLocation);
      expect(res.body).toBe('');
      expect(res.body).toBe(expectedBody);
    });

    // Test 4: tampered/unsigned cookie value.
    it('with a tampered cookie value, redirects to the uniform failure page', async () => {
      const nonce = generateNonce();
      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${nonce}`,
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${nonce}.not-a-real-signature`,
        },
      });
      expect(res.statusCode).toBe(302);
      expect(res.statusCode).toBe(expectedStatus);
      expect(res.headers.location).toBe(failureLocation);
      expect(res.body).toBe('');
      expect(res.body).toBe(expectedBody);
    });

    it('with a completely unsigned cookie value, redirects to the uniform failure page', async () => {
      const nonce = generateNonce();
      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${nonce}`,
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${nonce}` },
      });
      expect(res.statusCode).toBe(302);
      expect(res.statusCode).toBe(expectedStatus);
      expect(res.headers.location).toBe(failureLocation);
      expect(res.body).toBe('');
      expect(res.body).toBe(expectedBody);
    });

    // Test 5: failure uniformity — a state failure must be byte-identical to
    // a plain OAuth denial (no code/state at all from Google).
    it('a state failure is byte-identical to a bare OAuth denial (no query params)', async () => {
      const stateFailure = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${generateNonce()}`,
        headers: { cookie: realCookieFor(generateNonce()) },
      });
      const bareDenial = await app.inject({
        method: 'GET',
        url: '/auth/google/callback',
      });

      expect(stateFailure.statusCode).toBe(302);
      expect(bareDenial.statusCode).toBe(302);
      expect(stateFailure.statusCode).toBe(bareDenial.statusCode);
      expect(stateFailure.headers.location).toBe(bareDenial.headers.location);
      // Explicit contract on both sides, not just a comparison of one
      // against the other — if both started leaking the same non-empty
      // body, the equality check below would still pass.
      expect(stateFailure.body).toBe('');
      expect(bareDenial.body).toBe('');
      expect(stateFailure.body).toBe(bareDenial.body);
      expect(stateFailure.headers.location).toBe(failureLocation);
    });

    it('clears the sv_oauth_state cookie on a state-verification failure', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?state=${generateNonce()}`,
        headers: { cookie: realCookieFor(generateNonce()) },
      });
      const setCookie = res.headers['set-cookie'];
      const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const { name, value, attrs } = parseSetCookie(String(header));
      expect(name).toBe(OAUTH_STATE_COOKIE);
      expect(value).toBe('');
      expect(attrs.some((a) => a === 'Max-Age=0')).toBe(true);
    });
  });

  /**
   * Task 4b, success-path coverage: driving an actual browser through Google's
   * real OAuth consent screen isn't practical in a test (it needs a live code
   * exchange with accounts.google.com). Instead — following the same pattern
   * already used by google-callback-uniformity.e2e-spec.ts — GoogleAuthGuard is
   * overridden in a Nest testing module so it admits the request with a real
   * `req.user` already attached (standing in for a successful passport
   * `validate()`), and AuthService.loginWithGoogle is stubbed so no database
   * round-trip is needed either. What's left genuinely exercises the
   * controller's success branch and the real Fastify response pipeline that
   * caused Critical 3 (the implicit-200 bug affects this leg too, since it's
   * the same `res.redirect(url)` call site pattern as the failure leg).
   */
  describe('GET /auth/google/callback success path (stubbed passport + AuthService)', () => {
    class AdmitWithGoogleUserGuard implements CanActivate {
      canActivate(context: ExecutionContext): boolean {
        const req = context.switchToHttp().getRequest<{ user?: unknown }>();
        req.user = {
          googleId: 'g-success-test',
          email: 'success@example.com',
          emailVerified: true,
        };
        return true;
      }
    }

    let app: NestFastifyApplication;
    const APP_URL = process.env.APP_URL ?? 'http://localhost:9999';
    const fakeToken = 'fake-jwt-for-success-path-test';

    beforeAll(async () => {
      setGoogleEnv(GOOGLE_ENV);
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideGuard(GoogleAuthGuard)
        .useClass(AdmitWithGoogleUserGuard)
        .compile();

      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
        { rawBody: true },
      );
      app.get(AuthService).loginWithGoogle = jest
        .fn()
        .mockResolvedValue({ token: fakeToken, userId: 'u-success-test' });
      app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
      app.enableCors({ origin: true, credentials: true });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app.close();
      clearGoogleEnv();
    });

    it('redirects (302) to APP_URL/auth/callback?token=<token>', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/google/callback',
      });

      expect(res.statusCode).toBe(302);
      const location = String(res.headers.location);
      expect(location).toMatch(
        new RegExp(
          `^${APP_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/auth/callback\\?token=`,
        ),
      );
      expect(location).toContain(encodeURIComponent(fakeToken));
    });
  });

  describe('unconfigured (no GOOGLE_* vars)', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      clearGoogleEnv();
      app = await buildApp();
      await app.init();
      overrideGoogleConfig(app, {});
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => app.close());

    it('404s instead of exposing the route', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/google' });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('partially configured (client id set, secret + callback missing)', () => {
    let app: NestFastifyApplication;

    beforeAll(async () => {
      setGoogleEnv({ GOOGLE_CLIENT_ID: 'only-the-client-id' });
      app = await buildApp();
      await app.init();
      overrideGoogleConfig(app, { GOOGLE_CLIENT_ID: 'only-the-client-id' });
      await app.getHttpAdapter().getInstance().ready();
    });

    afterAll(async () => {
      await app.close();
      clearGoogleEnv();
    });

    it('boots successfully and 404s rather than 500ing', async () => {
      const res = await app.inject({ method: 'GET', url: '/auth/google' });
      expect(res.statusCode).toBe(404);
    });
  });
});
