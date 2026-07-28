import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Login-CSRF protection for the Google OAuth flow (Task 4b).
 *
 * GET /auth/google mints a nonce, signs it, and carries it on two channels:
 * a HttpOnly cookie and the OAuth `state` query parameter. GET
 * /auth/google/callback must see the same nonce on both — an attacker can
 * start the flow with their own Google account and forge/replay a `state`
 * value, but cannot read or set the victim's cookie, so the two legs can
 * never be stitched together across two different browsers.
 *
 * passport-oauth2's built-in state store requires `req.session` (this API is
 * stateless) and, even when configured via `state: { store }`, its
 * `store()`/`verify()` hooks are only ever handed the request — never the
 * response — so they cannot set or read this cookie either. See
 * google-auth.guard.ts for why the nonce is handled directly instead of
 * through that seam.
 *
 * The nonce carries a signed issue timestamp (see signNonce/verifySignedCookie
 * below) so expiry is enforced server-side against a value an attacker
 * cannot forge — not left to the cookie's own client-controlled Max-Age,
 * which a replayed cookie jar or an attacker's own months-old flow would
 * otherwise sail past unnoticed.
 */

export const OAUTH_STATE_COOKIE = 'sv_oauth_state';
const COOKIE_PATH = '/auth';
// Exported so tests can assert against the real window instead of
// duplicating the literal 600 and risking silent drift if it ever changes.
export const MAX_AGE_SECONDS = 600;
// Server-side enforcement mirrors the cookie's own Max-Age (both derive from
// MAX_AGE_SECONDS so they cannot drift apart). A cookie's Max-Age is only a
// client-side hint — nothing stops a saved cookie jar, or a value minted by
// an attacker from their own flow months earlier, from being replayed with
// the Max-Age constraint simply ignored — so the issue time is bound into
// the signed payload and re-checked here on every verification.
const MAX_AGE_MS = MAX_AGE_SECONDS * 1000;
// Small allowance for clock skew / imprecision between mint and verify. A
// legitimately-issued nonce is never verified before it was minted; this
// only exists to avoid rejecting a value a few milliseconds "in the future"
// due to ordinary clock jitter, not to tolerate a forged future timestamp.
const FUTURE_SKEW_MS = 60_000;
const HMAC_ALGO = 'sha256';
// Domain-separates this cookie's signing key from JWT_SECRET's other use
// (signing session JWTs) without needing a dedicated env var.
const DERIVATION_LABEL = 'sv-oauth-state-cookie';

function deriveSecret(jwtSecret: string): Buffer {
  return createHmac(HMAC_ALGO, jwtSecret).update(DERIVATION_LABEL).digest();
}

function hmac(secret: Buffer, value: string): string {
  return createHmac(HMAC_ALGO, secret).update(value).digest('base64url');
}

function timingSafeStringsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // crypto.timingSafeEqual throws on a length mismatch rather than returning
  // false, and the length check itself is not required to be constant-time.
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function generateNonce(): string {
  return randomBytes(32).toString('base64url');
}

/** Signed cookie value: `<nonce>.<issuedAtMs>.<HMAC(nonce + "." + issuedAtMs)>`.
 *  The issue time is part of the signed payload — not just a hint carried by
 *  the cookie's own Max-Age — so verifySignedCookie can enforce expiry
 *  server-side against a value an attacker cannot forge without the secret.
 *  Neither the nonce nor the timestamp is secret (both travel in the clear
 *  as the `state` query param / a non-HttpOnly-defeating cookie read isn't
 *  the threat model here); only the signature (and HttpOnly, which keeps
 *  script from reading the cookie at all) matter. */
export function signNonce(jwtSecret: string, nonce: string): string {
  const secret = deriveSecret(jwtSecret);
  const issuedAtMs = Date.now();
  const payload = `${nonce}.${issuedAtMs}`;
  return `${payload}.${hmac(secret, payload)}`;
}

/**
 * Verifies a signed cookie value and returns the embedded nonce, or `null` if
 * it is malformed, unsigned, tampered with, or expired.
 *
 * The HMAC is checked first, over the full `<nonce>.<issuedAtMs>` payload —
 * so an attacker who tampers with either field (not just the nonce) fails
 * the signature check before the timestamp is ever parsed or trusted. Only
 * once the signature has passed is `issuedAtMs` parsed and enforced against
 * the server-side expiry window; an unauthenticated number is never trusted.
 */
export function verifySignedCookie(
  jwtSecret: string,
  cookieValue: string,
): string | null {
  const lastDot = cookieValue.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === cookieValue.length - 1) return null;
  const payload = cookieValue.slice(0, lastDot);
  const signature = cookieValue.slice(lastDot + 1);
  const secret = deriveSecret(jwtSecret);
  const expected = hmac(secret, payload);
  if (!timingSafeStringsEqual(signature, expected)) return null;

  const dot = payload.lastIndexOf('.');
  if (dot <= 0 || dot === payload.length - 1) return null;
  const nonce = payload.slice(0, dot);
  const issuedAtRaw = payload.slice(dot + 1);
  if (!/^\d+$/.test(issuedAtRaw)) return null;
  const issuedAtMs = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAtMs)) return null;

  const age = Date.now() - issuedAtMs;
  if (age > MAX_AGE_MS) return null;
  if (age < -FUTURE_SKEW_MS) return null;

  return nonce;
}

/**
 * The actual CSRF check: does the (already-verified, so already known
 * signed-by-us) cookie nonce match the `state` query parameter the browser
 * carried back from Google? Timing-safe, length-checked first.
 */
export function nonceMatchesState(nonce: string, state: string): boolean {
  return timingSafeStringsEqual(nonce, state);
}

/**
 * The full callback-leg state check, as a pure function: does the signed
 * nonce carried by the `sv_oauth_state` cookie (read directly off the raw
 * `Cookie` header, so no Fastify/Express request-object coupling) match the
 * `state` the browser carried back from Google? Returns `false` on any
 * failure — missing cookie, missing state param, malformed/tampered/expired
 * cookie, or a nonce/state mismatch.
 *
 * Extracted as its own exported function (rather than inlined as a guard
 * method) specifically so it has a test seam: an inverted comparison here —
 * e.g. `!nonceMatchesState(...)` — would admit every forged `state` and
 * reject every legitimate one, silently killing Google sign-in while every
 * *negative* test (wrong cookie, no cookie, tampered signature) still
 * passes, since they only ever assert the failure path. Only a test that
 * exercises the true-returning case can catch that inversion.
 */
export function verifyState(
  cookieHeader: string | string[] | undefined,
  stateParam: string | null | undefined,
  jwtSecret: string,
): boolean {
  if (!stateParam) return false;
  const cookieValue = readCookie(cookieHeader, OAUTH_STATE_COOKIE);
  if (!cookieValue) return false;
  const nonce = verifySignedCookie(jwtSecret, cookieValue);
  if (!nonce) return false;
  return nonceMatchesState(nonce, stateParam);
}

function cookieAttrs(secure: boolean, extra: string[]): string[] {
  const attrs = [`Path=${COOKIE_PATH}`, 'HttpOnly', 'SameSite=Lax', ...extra];
  if (secure) attrs.push('Secure');
  return attrs;
}

export function buildStateCookieHeader(value: string, secure: boolean): string {
  return [
    `${OAUTH_STATE_COOKIE}=${value}`,
    ...cookieAttrs(secure, [`Max-Age=${MAX_AGE_SECONDS}`]),
  ].join('; ');
}

/** Expires the cookie immediately — called on every callback outcome so a
 *  captured nonce can never be replayed. */
export function buildClearStateCookieHeader(secure: boolean): string {
  return [`${OAUTH_STATE_COOKIE}=`, ...cookieAttrs(secure, ['Max-Age=0'])].join(
    '; ',
  );
}

/**
 * Reads one cookie's raw value out of a `Cookie` request header. Does not
 * URI-decode: our own values never need it, and calling decodeURIComponent
 * on an attacker-controlled cookie can throw on a malformed escape sequence.
 */
export function readCookie(
  cookieHeader: string | string[] | undefined,
  name: string,
): string | null {
  if (!cookieHeader) return null;
  const header = Array.isArray(cookieHeader)
    ? cookieHeader.join('; ')
    : cookieHeader;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
