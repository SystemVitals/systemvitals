import {
  slugify,
  isReservedOrgSlug,
  isValidSlug,
  uniqueSlug,
  MAX_SLUG_LENGTH,
} from './slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Autoclipper API')).toBe('autoclipper-api');
  });

  it('folds diacritics rather than dropping the letters', () => {
    expect(slugify('São Paulo')).toBe('sao-paulo');
    expect(slugify('Zürich Café')).toBe('zurich-cafe');
  });

  it('collapses runs of separators into one hyphen', () => {
    expect(slugify('a   ---  b')).toBe('a-b');
    expect(slugify('São Paulo — DB!')).toBe('sao-paulo-db');
  });

  it('trims leading and trailing separators', () => {
    expect(slugify('  -hello-  ')).toBe('hello');
    expect(slugify("nihey.takizawa's org")).toBe('nihey-takizawa-s-org');
  });

  it('falls back when nothing survives', () => {
    expect(slugify('')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
    expect(slugify('   ')).toBe('untitled');
  });

  it('caps length without leaving a trailing hyphen', () => {
    const long = 'a'.repeat(80);
    expect(slugify(long)).toHaveLength(MAX_SLUG_LENGTH);

    // 59 a's, then a separator, then more — truncation must not end on '-'
    const awkward = `${'a'.repeat(59)} bbbb`;
    const out = slugify(awkward);
    expect(out.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(out.endsWith('-')).toBe(false);
  });

  it('always produces a valid slug', () => {
    for (const input of ['São Paulo — DB!', '!!!', 'a'.repeat(80), 'A B']) {
      expect(isValidSlug(slugify(input))).toBe(true);
    }
  });

  describe('transliterates Latin letters with no NFD decomposition', () => {
    it('folds ø/Ø to o', () => {
      expect(slugify('Øystein')).toBe('oystein');
    });

    it('folds ł/Ł to l', () => {
      expect(slugify('Łódź')).toBe('lodz');
    });

    it('folds đ/Đ and ð/Ð to d', () => {
      expect(slugify('Đà Nẵng')).toBe('da-nang');
    });

    it('folds þ/Þ to th', () => {
      expect(slugify('Þórshöfn')).toBe('thorshofn');
    });

    it('folds ß to ss', () => {
      expect(slugify('Straße')).toBe('strasse');
    });

    it('folds æ/Æ to ae', () => {
      expect(slugify('Æther')).toBe('aether');
    });

    it('folds œ/Œ to oe', () => {
      expect(slugify('Œuvre')).toBe('oeuvre');
    });

    it('folds dotless ı to i', () => {
      expect(slugify('Kırşehir')).toBe('kirsehir');
    });

    it('keeps the length cap valid when a two-character expansion pushes past it', () => {
      // 58 a's followed by "straße" — the "ß" -> "ss" expansion pushes the
      // naive length past MAX_SLUG_LENGTH before truncation is applied.
      const input = `${'a'.repeat(58)} straße`;
      const out = slugify(input);
      expect(out.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
      expect(out.endsWith('-')).toBe(false);
      expect(isValidSlug(out)).toBe(true);
    });
  });
});

describe('isValidSlug', () => {
  it('accepts lowercase alphanumerics separated by single hyphens', () => {
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('api-health-2')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('-lead')).toBe(false);
    expect(isValidSlug('trail-')).toBe(false);
    expect(isValidSlug('double--hyphen')).toBe(false);
    expect(isValidSlug('Upper')).toBe(false);
    expect(isValidSlug('has space')).toBe(false);
    expect(isValidSlug('under_score')).toBe(false);
    expect(isValidSlug('a'.repeat(MAX_SLUG_LENGTH + 1))).toBe(false);
  });
});

describe('isReservedOrgSlug', () => {
  it('reserves every current top-level route', () => {
    for (const s of [
      'account',
      'admin',
      'auth',
      'billing',
      'channels',
      'checks',
      'dashboard',
      'escalation',
      'login',
      'signup',
      'status',
      'status-pages',
    ]) {
      expect(isReservedOrgSlug(s)).toBe(true);
    }
  });

  it('reserves framework and future paths', () => {
    for (const s of ['api', 'ping', 'settings', '_next', 'favicon.ico']) {
      expect(isReservedOrgSlug(s)).toBe(true);
    }
  });

  it('allows an ordinary org slug', () => {
    expect(isReservedOrgSlug('nihey-takizawa-s-org')).toBe(false);
    expect(isReservedOrgSlug('acme')).toBe(false);
  });

  it('is case-insensitive so a reserved word cannot slip through', () => {
    expect(isReservedOrgSlug('Admin')).toBe(true);
  });
});

describe('uniqueSlug', () => {
  it('returns the base when it is free', () => {
    expect(uniqueSlug('api-health', [])).toBe('api-health');
    expect(uniqueSlug('api-health', ['other'])).toBe('api-health');
  });

  it('suffixes on collision, counting up', () => {
    expect(uniqueSlug('api-health', ['api-health'])).toBe('api-health-2');
    expect(uniqueSlug('api-health', ['api-health', 'api-health-2'])).toBe(
      'api-health-3',
    );
  });

  it('skips a suffix that is itself taken', () => {
    expect(uniqueSlug('api', ['api', 'api-3'])).toBe('api-2');
    expect(uniqueSlug('api', ['api', 'api-2', 'api-3'])).toBe('api-4');
  });

  it('keeps the result within the length cap by trimming the base', () => {
    const base = 'a'.repeat(MAX_SLUG_LENGTH);
    const result = uniqueSlug(base, [base]);
    expect(result.length).toBeLessThanOrEqual(MAX_SLUG_LENGTH);
    expect(result.endsWith('-2')).toBe(true);
    expect(isValidSlug(result)).toBe(true);
  });

  it('accepts a Set as well as an array', () => {
    expect(uniqueSlug('api', new Set(['api']))).toBe('api-2');
  });
});
