export const MAX_SLUG_LENGTH = 60;

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const FALLBACK_SLUG = 'untitled';

/**
 * Latin letters with no canonical NFD decomposition. NFD only splits
 * precomposed letters (e.g. "á" -> "a" + combining acute); these are atomic
 * codepoints that pass through NFD unchanged and would otherwise be dropped
 * by the punctuation-stripping pass below. Transliterate them to their
 * conventional ASCII form first so the rest of the pipeline never sees them.
 */
const NON_DECOMPOSING_LATIN: Record<string, string> = {
  ø: 'o',
  Ø: 'o',
  ł: 'l',
  Ł: 'l',
  đ: 'd',
  Đ: 'd',
  ð: 'd',
  Ð: 'd',
  þ: 'th',
  Þ: 'th',
  ß: 'ss',
  æ: 'ae',
  Æ: 'ae',
  œ: 'oe',
  Œ: 'oe',
  ı: 'i',
};

const NON_DECOMPOSING_LATIN_PATTERN = new RegExp(
  `[${Object.keys(NON_DECOMPOSING_LATIN).join('')}]`,
  'g',
);

/** Replace Latin letters that NFD cannot fold, before NFD ever runs. */
function transliterateNonDecomposing(value: string): string {
  return value.replace(
    NON_DECOMPOSING_LATIN_PATTERN,
    (char) => NON_DECOMPOSING_LATIN[char] ?? char,
  );
}

/**
 * Organization slugs occupy the first URL segment, so they share a namespace
 * with every application route. Project and check slugs sit in deeper segments
 * and need no such list.
 *
 * ADDING A TOP-LEVEL ROUTE? Add it here too, or an organization holding that
 * slug will silently shadow the new route.
 */
const RESERVED_ORG_SLUGS = new Set([
  // live routes
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
  // future and framework paths
  'api',
  'ping',
  'settings',
  'docs',
  'help',
  'new',
  'org',
  'orgs',
  'team',
  'teams',
  'projects',
  'pricing',
  'about',
  'blog',
  'terms',
  'privacy',
  'contact',
  'support',
  '_next',
  'static',
  'favicon.ico',
  'robots.txt',
  'sitemap.xml',
]);

/** Trim hyphens from both ends. */
function trimHyphens(value: string): string {
  return value.replace(/^-+/, '').replace(/-+$/, '');
}

/**
 * Turn arbitrary user text into a URL-safe slug.
 *
 * Diacritics are folded to their base letter rather than dropped, so
 * "São Paulo" stays readable as "sao-paulo" instead of collapsing to "so-paulo".
 */
export function slugify(input: string): string {
  const folded = transliterateNonDecomposing(input)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

  const hyphenated = trimHyphens(folded.replace(/[^a-z0-9]+/g, '-'));
  if (!hyphenated) return FALLBACK_SLUG;

  // Truncating can land mid-word and leave a trailing hyphen; trim again after.
  const capped = trimHyphens(hyphenated.slice(0, MAX_SLUG_LENGTH));
  return capped || FALLBACK_SLUG;
}

export function isValidSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_LENGTH && SLUG_PATTERN.test(slug);
}

export function isReservedOrgSlug(slug: string): boolean {
  return RESERVED_ORG_SLUGS.has(slug.toLowerCase());
}

/**
 * First free slug in the series `base`, `base-2`, `base-3`, …
 *
 * The base is trimmed when a suffix would exceed the length cap, so the result
 * is always a valid slug.
 */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;

  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const room = MAX_SLUG_LENGTH - suffix.length;
    const candidate = `${trimHyphens(base.slice(0, room))}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
