import {
  buildClearStateCookieHeader,
  buildStateCookieHeader,
  generateNonce,
  MAX_AGE_SECONDS,
  nonceMatchesState,
  OAUTH_STATE_COOKIE,
  readCookie,
  signNonce,
  verifySignedCookie,
  verifyState,
} from './oauth-state';

const SECRET = 'a-jwt-secret-that-is-long-enough';
const OTHER_SECRET = 'a-different-jwt-secret-long-enough';
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;

describe('oauth-state', () => {
  describe('generateNonce', () => {
    it('produces distinct, non-trivial nonces', () => {
      const a = generateNonce();
      const b = generateNonce();
      expect(a).not.toEqual(b);
      expect(a.length).toBeGreaterThan(20);
    });
  });

  describe('signNonce / verifySignedCookie', () => {
    it('round-trips: a freshly signed cookie verifies back to the same nonce', () => {
      const nonce = generateNonce();
      const cookieValue = signNonce(SECRET, nonce);
      expect(verifySignedCookie(SECRET, cookieValue)).toBe(nonce);
    });

    it('rejects a cookie signed with a different secret', () => {
      const nonce = generateNonce();
      const cookieValue = signNonce(OTHER_SECRET, nonce);
      expect(verifySignedCookie(SECRET, cookieValue)).toBeNull();
    });

    it('rejects a tampered nonce (signature no longer matches)', () => {
      const nonce = generateNonce();
      const cookieValue = signNonce(SECRET, nonce);
      const [, signature] = cookieValue.split('.');
      const tampered = `${nonce}-tampered.${signature}`;
      expect(verifySignedCookie(SECRET, tampered)).toBeNull();
    });

    it('rejects a tampered signature', () => {
      const nonce = generateNonce();
      const tampered = `${nonce}.not-the-real-signature`;
      expect(verifySignedCookie(SECRET, tampered)).toBeNull();
    });

    it('rejects a value with no signature separator', () => {
      expect(verifySignedCookie(SECRET, 'just-a-nonce-no-dot')).toBeNull();
    });

    it('rejects an empty signature', () => {
      const nonce = generateNonce();
      expect(verifySignedCookie(SECRET, `${nonce}.`)).toBeNull();
    });

    it('rejects an empty string', () => {
      expect(verifySignedCookie(SECRET, '')).toBeNull();
    });

    describe('server-side expiry (Fix 1: the issue time is part of the signed payload, not just the cookie Max-Age hint)', () => {
      afterEach(() => {
        jest.restoreAllMocks();
      });

      it('rejects a timestamp well outside the max-age window', () => {
        const nonce = generateNonce();
        const t0 = 1_700_000_000_000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
        const cookieValue = signNonce(SECRET, nonce);

        // Ten windows' worth of time have elapsed since minting.
        now.mockReturnValue(t0 + MAX_AGE_MS * 10);
        expect(verifySignedCookie(SECRET, cookieValue)).toBeNull();
      });

      it('accepts a timestamp just inside the max-age window', () => {
        const nonce = generateNonce();
        const t0 = 1_700_000_000_000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
        const cookieValue = signNonce(SECRET, nonce);

        // One second before the window closes.
        now.mockReturnValue(t0 + MAX_AGE_MS - 1000);
        expect(verifySignedCookie(SECRET, cookieValue)).toBe(nonce);
      });

      it('rejects a cookie whose timestamp was bumped after signing, even with the original nonce and signature intact', () => {
        const nonce = generateNonce();
        const t0 = 1_700_000_000_000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
        const cookieValue = signNonce(SECRET, nonce);
        const [, , signature] = cookieValue.split('.');

        // Bump issuedAtMs forward — e.g. an attempt to "renew" an old cookie
        // without knowing the secret — while keeping the original nonce and
        // signature untouched.
        const tampered = `${nonce}.${t0 + 1}.${signature}`;
        expect(tampered).not.toBe(cookieValue);

        now.mockReturnValue(t0 + 1000);
        expect(verifySignedCookie(SECRET, tampered)).toBeNull();
      });

      it('rejects a timestamp implausibly far in the future, beyond clock-skew tolerance', () => {
        const nonce = generateNonce();
        const t0 = 1_700_000_000_000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(t0);
        const cookieValue = signNonce(SECRET, nonce);

        // "Verify" well before the nonce was ever issued.
        now.mockReturnValue(t0 - 5 * 60 * 1000);
        expect(verifySignedCookie(SECRET, cookieValue)).toBeNull();
      });

      it('rejects a non-numeric issuedAtMs', () => {
        const nonce = generateNonce();
        const cookieValue = `${nonce}.not-a-number.whatever-signature`;
        expect(verifySignedCookie(SECRET, cookieValue)).toBeNull();
      });
    });
  });

  describe('verifyState (Fix 2: the full callback-leg check as a directly-testable pure function)', () => {
    it('POSITIVE PATH: returns true when the signed cookie nonce matches the state param', () => {
      const nonce = generateNonce();
      const cookieValue = signNonce(SECRET, nonce);
      const cookieHeader = `${OAUTH_STATE_COOKIE}=${cookieValue}`;
      expect(verifyState(cookieHeader, nonce, SECRET)).toBe(true);
    });

    it('returns false when there is no cookie header at all', () => {
      expect(verifyState(undefined, generateNonce(), SECRET)).toBe(false);
    });

    it('returns false when there is no state param', () => {
      const nonce = generateNonce();
      const cookieValue = signNonce(SECRET, nonce);
      const cookieHeader = `${OAUTH_STATE_COOKIE}=${cookieValue}`;
      expect(verifyState(cookieHeader, null, SECRET)).toBe(false);
      expect(verifyState(cookieHeader, undefined, SECRET)).toBe(false);
    });

    it('returns false when the cookie nonce and state param disagree', () => {
      const nonce = generateNonce();
      const cookieValue = signNonce(SECRET, nonce);
      const cookieHeader = `${OAUTH_STATE_COOKIE}=${cookieValue}`;
      expect(verifyState(cookieHeader, generateNonce(), SECRET)).toBe(false);
    });

    it('returns false when the cookie is tampered/unsigned', () => {
      const nonce = generateNonce();
      const cookieHeader = `${OAUTH_STATE_COOKIE}=${nonce}.not-a-real-signature`;
      expect(verifyState(cookieHeader, nonce, SECRET)).toBe(false);
    });
  });

  describe('nonceMatchesState', () => {
    it('matches identical strings', () => {
      const nonce = generateNonce();
      expect(nonceMatchesState(nonce, nonce)).toBe(true);
    });

    it('rejects a different value of the same length', () => {
      const a = 'A'.repeat(43);
      const b = 'B'.repeat(43);
      expect(nonceMatchesState(a, b)).toBe(false);
    });

    it('rejects a different length without throwing', () => {
      expect(() =>
        nonceMatchesState('short', 'a-much-longer-value'),
      ).not.toThrow();
      expect(nonceMatchesState('short', 'a-much-longer-value')).toBe(false);
    });
  });

  describe('cookie header builders', () => {
    it('buildStateCookieHeader includes HttpOnly, SameSite=Lax, Path, Max-Age', () => {
      const header = buildStateCookieHeader('signed-value', false);
      expect(header).toContain(`${OAUTH_STATE_COOKIE}=signed-value`);
      expect(header).toContain('HttpOnly');
      expect(header).toContain('SameSite=Lax');
      expect(header).toContain('Path=/auth');
      expect(header).toContain('Max-Age=600');
      expect(header).not.toContain('Secure');
    });

    it('buildStateCookieHeader adds Secure when requested', () => {
      expect(buildStateCookieHeader('v', true)).toContain('Secure');
    });

    it('buildClearStateCookieHeader empties the value and zeroes Max-Age', () => {
      const header = buildClearStateCookieHeader(false);
      expect(header).toContain(`${OAUTH_STATE_COOKIE}=;`);
      expect(header).toContain('Max-Age=0');
    });
  });

  describe('readCookie', () => {
    it('extracts a cookie by name from a multi-cookie header', () => {
      const header = `foo=bar; ${OAUTH_STATE_COOKIE}=abc123; baz=qux`;
      expect(readCookie(header, OAUTH_STATE_COOKIE)).toBe('abc123');
    });

    it('returns null when the cookie is absent', () => {
      expect(readCookie('foo=bar', OAUTH_STATE_COOKIE)).toBeNull();
    });

    it('returns null when the header is undefined', () => {
      expect(readCookie(undefined, OAUTH_STATE_COOKIE)).toBeNull();
    });

    it('does not URI-decode (and does not throw on malformed escapes)', () => {
      const header = `${OAUTH_STATE_COOKIE}=abc%zz123`;
      expect(() => readCookie(header, OAUTH_STATE_COOKIE)).not.toThrow();
      expect(readCookie(header, OAUTH_STATE_COOKIE)).toBe('abc%zz123');
    });
  });
});
