import {
  createEmailVerificationToken,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_TTL_MS,
  hashEmailVerificationToken,
  maskEmailDestination,
  normalizeEmailDestination,
} from './email-verification-token';

describe('email verification token policy', () => {
  it('hashes a token as a deterministic lowercase SHA-256 digest', () => {
    expect(hashEmailVerificationToken('hello')).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('creates an opaque token with a separate SHA-256 hash and exact expiry', () => {
    const now = new Date('2026-07-27T12:00:00.000Z');

    const token = createEmailVerificationToken(now);

    expect(token.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(token.tokenHash).toBe(hashEmailVerificationToken(token.rawToken));
    expect(token.tokenHash).not.toBe(token.rawToken);
    expect(token.expiresAt.getTime()).toBe(
      now.getTime() + EMAIL_VERIFICATION_TTL_MS,
    );
  });

  it('creates independently random raw tokens', () => {
    expect(createEmailVerificationToken().rawToken).not.toBe(
      createEmailVerificationToken().rawToken,
    );
  });

  it('uses the intended resend cooldown', () => {
    expect(EMAIL_VERIFICATION_RESEND_COOLDOWN_MS).toBe(60_000);
  });
});

describe('normalizeEmailDestination', () => {
  it('trims the address, preserves local-part case, and lowercases only its domain', () => {
    expect(normalizeEmailDestination('  Alerts+Ops@EXAMPLE.COM  ')).toBe(
      'Alerts+Ops@example.com',
    );
  });

  it.each([
    '',
    '   ',
    'alerts@example',
    'alerts@@example.com',
    '.alerts@example.com',
    'alerts.@example.com',
    'alerts..ops@example.com',
    'alerts@-example.com',
    'alerts@example-.com',
    'alerts@example..com',
    'alerts@example.com\nother@example.com',
    `alerts@${'a'.repeat(64)}.com`,
    `${'a'.repeat(65)}@example.com`,
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}.com`,
  ])('rejects malformed or oversized email destination %p', (email) => {
    expect(() => normalizeEmailDestination(email)).toThrow(
      'Invalid email destination',
    );
  });
});

describe('maskEmailDestination', () => {
  it('reveals only the first local-part character', () => {
    expect(maskEmailDestination('alerts@example.com')).toBe(
      'a•••••@example.com',
    );
  });

  it('never throws or leaks malformed input', () => {
    const malformed = 'not-an-email\nsecret@example.com';

    expect(() => maskEmailDestination(malformed)).not.toThrow();
    expect(maskEmailDestination(malformed)).toBe('•••');
    expect(maskEmailDestination(malformed)).not.toContain('secret');
  });

  it('caps a valid masked destination for an unusually long domain', () => {
    const email = `a@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`;

    const masked = maskEmailDestination(email);

    expect(masked.length).toBeLessThanOrEqual(128);
    expect(masked).toContain('a@');
  });
});
