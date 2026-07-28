import type { ConfigService } from '@nestjs/config';
import type { Profile } from 'passport-google-oauth20';
import { GoogleStrategy } from './google.strategy';

function makeStrategy(env: Partial<Record<string, string>> = {}) {
  const cfg = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  return new GoogleStrategy(cfg);
}

function makeProfile(opts: {
  emailVerifiedRaw?: boolean | string;
  hasEmail?: boolean;
}): Profile {
  const { emailVerifiedRaw, hasEmail = true } = opts;
  return {
    id: 'google-id-1',
    provider: 'google',
    // Mirrors passport-google-oauth20's openid profile parser: emails[0].verified
    // and _json.email_verified carry the identical raw value from Google.
    emails: hasEmail
      ? [{ value: 'user@example.com', verified: emailVerifiedRaw as never }]
      : undefined,
    _json: { email_verified: emailVerifiedRaw },
  } as unknown as Profile;
}

describe('GoogleStrategy', () => {
  const strategy = makeStrategy();

  it('boolean true email_verified yields emailVerified: true', () => {
    const identity = strategy.validate(
      'at',
      'rt',
      makeProfile({ emailVerifiedRaw: true }),
    );
    expect(identity.emailVerified).toBe(true);
    expect(identity.email).toBe('user@example.com');
  });

  it('boolean false email_verified yields emailVerified: false', () => {
    const identity = strategy.validate(
      'at',
      'rt',
      makeProfile({ emailVerifiedRaw: false }),
    );
    expect(identity.emailVerified).toBe(false);
  });

  it('string "true" email_verified yields emailVerified: true (Google may send a string)', () => {
    const identity = strategy.validate(
      'at',
      'rt',
      makeProfile({ emailVerifiedRaw: 'true' }),
    );
    expect(identity.emailVerified).toBe(true);
  });

  it('string "false" email_verified must NOT yield emailVerified: true', () => {
    const identity = strategy.validate(
      'at',
      'rt',
      makeProfile({ emailVerifiedRaw: 'false' }),
    );
    expect(identity.emailVerified).toBe(false);
  });

  it('a profile with no email is never emailVerified, even if the raw flag is true', () => {
    const identity = strategy.validate(
      'at',
      'rt',
      makeProfile({ emailVerifiedRaw: true, hasEmail: false }),
    );
    expect(identity.email).toBe('');
    expect(identity.emailVerified).toBe(false);
  });

  describe('construction with missing config', () => {
    const originalEnv = process.env.NODE_ENV;
    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it('never throws — falls back to inert dummy credentials', () => {
      expect(() => makeStrategy({})).not.toThrow();
    });

    it('warns once in production when config is incomplete', () => {
      process.env.NODE_ENV = 'production';
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      makeStrategy({ GOOGLE_CLIENT_ID: 'only-id' });
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('does not warn outside production', () => {
      process.env.NODE_ENV = 'test';
      const warn = jest.spyOn(console, 'warn').mockImplementation();
      makeStrategy({});
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
