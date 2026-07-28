/**
 * Canonical form for storage and lookup: trimmed and lowercased.
 *
 * Email local-parts are technically case-sensitive per RFC 5321, but no
 * real-world provider treats them that way, and Google always returns
 * lowercase — so comparing byte-exact silently creates duplicate accounts.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
