import { createHash, randomBytes } from 'node:crypto';

export const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const EMAIL_VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

const MAX_EMAIL_DESTINATION_LENGTH = 254;
const MAX_EMAIL_LOCAL_PART_LENGTH = 64;
const MAX_EMAIL_DOMAIN_LENGTH = 253;
const MAX_EMAIL_DOMAIN_LABEL_LENGTH = 63;
const MAX_MASKED_EMAIL_DESTINATION_LENGTH = 128;
const MASKED_INVALID_DESTINATION = '•••';
const EMAIL_LOCAL_PART_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const EMAIL_DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function hashEmailVerificationToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

export function createEmailVerificationToken(now = new Date()): {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
} {
  const rawToken = randomBytes(32).toString('base64url');

  return {
    rawToken,
    tokenHash: hashEmailVerificationToken(rawToken),
    expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
  };
}

/**
 * Normalizes an email address intended for delivery while keeping its local
 * part byte-for-byte intact. Domains are case-insensitive and stored lowercase.
 */
export function normalizeEmailDestination(email: string): string {
  if (
    Array.from(email).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    throw new Error('Invalid email destination');
  }

  const normalized = email.trim();
  const at = normalized.indexOf('@');
  if (
    normalized.length === 0 ||
    normalized.length > MAX_EMAIL_DESTINATION_LENGTH ||
    at < 1 ||
    at !== normalized.lastIndexOf('@')
  ) {
    throw new Error('Invalid email destination');
  }

  const localPart = normalized.slice(0, at);
  const domain = normalized.slice(at + 1).toLowerCase();
  if (
    localPart.length > MAX_EMAIL_LOCAL_PART_LENGTH ||
    domain.length === 0 ||
    domain.length > MAX_EMAIL_DOMAIN_LENGTH ||
    !EMAIL_LOCAL_PART_PATTERN.test(localPart)
  ) {
    throw new Error('Invalid email destination');
  }

  const labels = domain.split('.');
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > MAX_EMAIL_DOMAIN_LABEL_LENGTH ||
        !EMAIL_DOMAIN_LABEL_PATTERN.test(label),
    )
  ) {
    throw new Error('Invalid email destination');
  }

  return `${localPart}@${domain}`;
}

/** Returns a bounded, public-safe representation of a valid email address. */
export function maskEmailDestination(email: string): string {
  try {
    const normalized = normalizeEmailDestination(email);
    const at = normalized.indexOf('@');
    const localPart = normalized.slice(0, at);
    const masked = `${localPart[0]}${'•'.repeat(Math.max(0, localPart.length - 1))}${normalized.slice(at)}`;

    return masked.slice(0, MAX_MASKED_EMAIL_DESTINATION_LENGTH);
  } catch {
    return MASKED_INVALID_DESTINATION;
  }
}
