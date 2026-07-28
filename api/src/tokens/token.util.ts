import { randomBytes, createHash } from 'crypto';

export function generateToken(): {
  plaintext: string;
  prefix: string;
  hash: string;
} {
  const raw = randomBytes(20).toString('hex'); // 40 hex chars
  const plaintext = `svt_${raw}`;
  return {
    plaintext,
    prefix: plaintext.slice(0, 12),
    hash: createHash('sha256').update(plaintext).digest('hex'),
  };
}

export function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}
