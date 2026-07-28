import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GoogleAuthGuard } from './google-auth.guard';
import {
  GOOGLE_AUTH_HANDLER_NAME,
  GOOGLE_CALLBACK_HANDLER_NAME,
} from './google-auth-handlers';
import {
  OAUTH_STATE_COOKIE,
  buildStateCookieHeader,
  generateNonce,
  signNonce,
  verifySignedCookie,
} from './oauth-state';

const FULL_CONFIG = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALLBACK_URL: 'https://api.example.com/auth/google/callback',
  JWT_SECRET: 'a-jwt-secret-that-is-long-enough',
};

function makeGuard(env: Partial<Record<string, string>>) {
  const cfg = {
    get: jest.fn((key: string) => env[key]),
    getOrThrow: jest.fn((key: string) => {
      const value = env[key];
      if (value === undefined) throw new Error(`missing ${key}`);
      return value;
    }),
  } as unknown as ConfigService;
  return new GoogleAuthGuard(cfg);
}

/** Builds an ExecutionContext whose getHandler().name matches `handlerName`,
 *  wired to the given request/response pair. `res` is deliberately loose —
 *  callers pass either `{ raw: { setHeader } }` (authorize-leg shape) or
 *  `{ header: jest.fn() }` (callback-leg shape), never both. */
function makeContext(
  handlerName:
    | typeof GOOGLE_AUTH_HANDLER_NAME
    | typeof GOOGLE_CALLBACK_HANDLER_NAME,
  req: unknown,
  res: unknown,
): ExecutionContext {
  return {
    getHandler: () => {
      const fn = () => undefined;
      Object.defineProperty(fn, 'name', { value: handlerName });
      return fn;
    },
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
}

const ctx = {} as ExecutionContext;

describe('GoogleAuthGuard', () => {
  it('404s when none of the Google vars are configured', () => {
    expect(() => makeGuard({}).canActivate(ctx)).toThrow(NotFoundException);
  });

  it.each([
    ['GOOGLE_CLIENT_ID'],
    ['GOOGLE_CLIENT_SECRET'],
    ['GOOGLE_CALLBACK_URL'],
  ] as const)('404s when only %s is missing', (missingKey) => {
    const env = { ...FULL_CONFIG };
    delete env[missingKey];
    expect(() => makeGuard(env).canActivate(ctx)).toThrow(NotFoundException);
  });

  it('returns null instead of throwing when passport fails', () => {
    const guard = makeGuard(FULL_CONFIG);
    expect(guard.handleRequest(new Error('denied'), false)).toBeNull();
    expect(guard.handleRequest(null, false)).toBeNull();
  });

  it('passes the user through on success', () => {
    const guard = makeGuard(FULL_CONFIG);
    const user = { googleId: 'g1', email: 'a@b.com', emailVerified: true };
    expect(guard.handleRequest(null, user)).toBe(user);
  });

  it('getResponse returns the raw Node response, not the Fastify wrapper', () => {
    const guard = makeGuard(FULL_CONFIG);
    const raw = { setHeader: jest.fn(), end: jest.fn() };
    const reply = { raw } as unknown as FastifyReply;
    const context = {
      switchToHttp: () => ({
        getResponse: () => reply,
      }),
    } as unknown as ExecutionContext;
    expect(guard.getResponse(context)).toBe(raw);
  });

  describe('getAuthenticateOptions (state nonce minting — authorize leg only)', () => {
    it('on the authorize leg, sets a Set-Cookie header on the RAW response and returns state', () => {
      const guard = makeGuard(FULL_CONFIG);
      const setHeader = jest.fn();
      const context = makeContext(
        GOOGLE_AUTH_HANDLER_NAME,
        {},
        { raw: { setHeader } as unknown },
      );

      const options = guard.getAuthenticateOptions(context);

      expect(options).toBeDefined();
      expect(typeof options?.state).toBe('string');
      expect(setHeader).toHaveBeenCalledTimes(1);
      const [headerName, headerValue] = setHeader.mock.calls[0] as [
        string,
        string,
      ];
      expect(headerName).toBe('Set-Cookie');
      // The trap: this must be the raw setHeader, never reply.header/setCookie.
      expect(headerValue).toContain(`${OAUTH_STATE_COOKIE}=`);
      expect(headerValue).toContain('HttpOnly');
      expect(headerValue).toContain('SameSite=Lax');
      expect(headerValue).toContain('Path=/auth');

      // The cookie actually carries the same nonce handed back as `state`.
      const cookieValue = headerValue.split(';')[0].split('=')[1];
      expect(verifySignedCookie(FULL_CONFIG.JWT_SECRET, cookieValue)).toBe(
        options?.state,
      );
    });

    it('marks the cookie Secure outside development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        const guard = makeGuard(FULL_CONFIG);
        const setHeader = jest.fn();
        const context = makeContext(
          GOOGLE_AUTH_HANDLER_NAME,
          {},
          { raw: { setHeader } as unknown },
        );
        guard.getAuthenticateOptions(context);
        const [, headerValue] = setHeader.mock.calls[0] as [string, string];
        expect(headerValue).toContain('Secure');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('omits Secure in development', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';
      try {
        const guard = makeGuard(FULL_CONFIG);
        const setHeader = jest.fn();
        const context = makeContext(
          GOOGLE_AUTH_HANDLER_NAME,
          {},
          { raw: { setHeader } as unknown },
        );
        guard.getAuthenticateOptions(context);
        const [, headerValue] = setHeader.mock.calls[0] as [string, string];
        expect(headerValue).not.toContain('Secure');
      } finally {
        process.env.NODE_ENV = originalEnv;
      }
    });

    it('on the callback leg, does nothing and returns undefined', () => {
      const guard = makeGuard(FULL_CONFIG);
      const setHeader = jest.fn();
      const context = makeContext(
        GOOGLE_CALLBACK_HANDLER_NAME,
        {},
        { raw: { setHeader } as unknown },
      );
      expect(guard.getAuthenticateOptions(context)).toBeUndefined();
      expect(setHeader).not.toHaveBeenCalled();
    });
  });

  describe('canActivate on the callback leg (state verification)', () => {
    it('admits the request with req.user = null when there is no cookie at all', () => {
      const guard = makeGuard(FULL_CONFIG);
      const headerFn = jest.fn();
      const req = {
        headers: {},
        query: { state: 'whatever' },
      } as unknown as FastifyRequest & { user?: unknown };
      const context = makeContext(GOOGLE_CALLBACK_HANDLER_NAME, req, {
        header: headerFn,
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.user).toBeNull();
      // Cleared regardless — a captured nonce must never be replayable.
      expect(headerFn).toHaveBeenCalledWith(
        'Set-Cookie',
        expect.stringContaining(`${OAUTH_STATE_COOKIE}=;`),
      );
    });

    it('THE REGRESSION CHECK: admits with req.user = null when the cookie nonce and state param disagree', () => {
      const guard = makeGuard(FULL_CONFIG);
      const nonce = generateNonce();
      const differentNonce = generateNonce();
      const signedCookie = signNonce(FULL_CONFIG.JWT_SECRET, nonce);
      const req = {
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${signedCookie}` },
        // A real signed cookie for `nonce`, but the browser's `state` query
        // param — which an attacker fully controls when replaying their own
        // authorization code — carries a *different* nonce.
        query: { state: differentNonce },
      } as unknown as FastifyRequest & { user?: unknown };
      const context = makeContext(GOOGLE_CALLBACK_HANDLER_NAME, req, {
        header: jest.fn(),
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.user).toBeNull();
    });

    it('admits with req.user = null when the cookie is unsigned/tampered', () => {
      const guard = makeGuard(FULL_CONFIG);
      const nonce = generateNonce();
      const req = {
        headers: {
          cookie: `${OAUTH_STATE_COOKIE}=${nonce}.not-a-real-signature`,
        },
        query: { state: nonce },
      } as unknown as FastifyRequest & { user?: unknown };
      const context = makeContext(GOOGLE_CALLBACK_HANDLER_NAME, req, {
        header: jest.fn(),
      });

      expect(guard.canActivate(context)).toBe(true);
      expect(req.user).toBeNull();
    });

    it('sanity: buildStateCookieHeader/signNonce agree with what getAuthenticateOptions produces', () => {
      // Guards against the two cookie-building code paths silently drifting.
      const nonce = generateNonce();
      const cookieValue = signNonce(FULL_CONFIG.JWT_SECRET, nonce);
      const header = buildStateCookieHeader(cookieValue, false);
      expect(header.split(';')[0]).toBe(`${OAUTH_STATE_COOKIE}=${cookieValue}`);
    });

    /**
     * POSITIVE PATH: every other test in this describe block asserts the
     * *failure* redirect (req.user forced to null). None of them would
     * notice if the underlying comparison were inverted — an always-false
     * verifyState would still make every one of those tests pass. This test
     * supplies a cookie/state pair that genuinely satisfies verifyState and
     * observes that the guard actually admits the request onward to
     * passport (super.canActivate), instead of nulling out req.user.
     * super.canActivate itself is stubbed out — this test isn't exercising
     * passport-oauth2, only that GoogleAuthGuard's own state check took the
     * true branch. See oauth-state.spec.ts's 'verifyState' describe block
     * for the direct, guard-independent positive-path coverage of the
     * comparison itself.
     */
    it('with a matching signed cookie and state, admits the request onward instead of nulling req.user', () => {
      const guard = makeGuard(FULL_CONFIG);
      const nonce = generateNonce();
      const signedCookie = signNonce(FULL_CONFIG.JWT_SECRET, nonce);
      const req = {
        headers: { cookie: `${OAUTH_STATE_COOKIE}=${signedCookie}` },
        query: { state: nonce },
      } as unknown as FastifyRequest & { user?: unknown };
      const context = makeContext(GOOGLE_CALLBACK_HANDLER_NAME, req, {
        header: jest.fn(),
      });

      const superProto = Object.getPrototypeOf(GoogleAuthGuard.prototype) as {
        canActivate: (context: ExecutionContext) => unknown;
      };
      const superCanActivate = jest
        .spyOn(superProto, 'canActivate')
        .mockImplementation(() => true);

      try {
        expect(guard.canActivate(context)).toBe(true);
        expect(superCanActivate).toHaveBeenCalledTimes(1);
        expect(req.user).not.toBeNull();
      } finally {
        superCanActivate.mockRestore();
      }
    });
  });
});
