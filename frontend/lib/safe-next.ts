/**
 * Validates a `?next=` redirect target read from the query string.
 *
 * This is a security control, not a convenience helper: `next` is
 * attacker-controlled (it comes straight from the URL an invitee clicks), so
 * only a same-origin relative path is ever accepted. Everything else falls
 * back to `/dashboard`.
 *
 * Rejected as open-redirect vectors:
 * - anything that doesn't start with a single `/` (e.g. `https://evil.com`)
 * - `//evil.com` — a protocol-relative URL; browsers resolve a leading `//`
 *   against the current scheme, so `router.push("//evil.com")` navigates
 *   off-site even though the string "starts with /".
 * - `/\evil.com` — some browsers normalize a leading backslash to a slash,
 *   turning this into the `//evil.com` case above.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return "/dashboard";
  if (!raw.startsWith("/")) return "/dashboard";
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/dashboard";
  return raw;
}
