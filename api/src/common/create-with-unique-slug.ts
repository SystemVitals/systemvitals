import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@systemvitals/database';
import { uniqueSlug } from './slug';

/**
 * Slug generation is read-then-write: compute a candidate against the
 * currently-taken slugs, then insert. Two concurrent creates with the same
 * name can compute the identical candidate, so only the first insert wins
 * the unique constraint and the rest fail with a raw P2002.
 *
 * Per the product rule that creation must never fail because a name is
 * reused, callers use this helper instead of a bare `create`: on a
 * slug-specific unique-constraint violation it reloads the now-current taken
 * set, recomputes the slug, and retries — bounded so a pathological run of
 * collisions can't loop forever.
 *
 * `uniqueSlug` is deterministic given a taken set, so a batch of concurrent
 * same-name creates that all read before any of them writes tends to
 * converge in lockstep — round 1 lets exactly one through, round 2 lets one
 * more through, and so on. The bound is set comfortably above the largest
 * concurrent batch this codebase demonstrates (10) so that pattern always
 * resolves every request rather than exhausting a "handful" of retries.
 */
const MAX_SLUG_CREATE_ATTEMPTS = 20;

export async function createWithUniqueSlug<T>(options: {
  /** Pre-slugified base (i.e. `slugify(name)`), computed once by the caller. */
  base: string;
  /** Re-run on every attempt so retries see the latest concurrent writes. */
  loadTakenSlugs: () => Promise<string[]>;
  /** Attempt the actual insert with the given candidate slug. */
  create: (slug: string) => Promise<T>;
  /** Used only in the exhausted-retries error message, e.g. "check". */
  entityLabel: string;
}): Promise<T> {
  const { base, loadTakenSlugs, create, entityLabel } = options;

  for (let attempt = 1; attempt <= MAX_SLUG_CREATE_ATTEMPTS; attempt++) {
    const taken = await loadTakenSlugs();
    const slug = uniqueSlug(base, taken);
    try {
      return await create(slug);
    } catch (err) {
      if (!isSlugUniqueConflict(err)) throw err;
      if (attempt === MAX_SLUG_CREATE_ATTEMPTS) {
        throw new BadRequestException(
          `Could not generate a unique slug for this ${entityLabel} after ${MAX_SLUG_CREATE_ATTEMPTS} attempts due to concurrent creates; please retry.`,
        );
      }
      // Slug lost the race to a concurrent create — reload and retry.
    }
  }
  // Unreachable — the loop above always returns or throws — but keeps the
  // compiler satisfied that every path yields a T or an error.
  throw new BadRequestException(
    `Could not generate a unique slug for this ${entityLabel}; please retry.`,
  );
}

function isSlugUniqueConflict(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002' &&
    Array.isArray(err.meta?.target) &&
    (err.meta.target as unknown[]).includes('slug')
  );
}
