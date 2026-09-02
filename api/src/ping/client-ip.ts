import { isIP } from 'node:net';

export function normalizeClientIp(
  value: string | undefined | null,
): string | null {
  if (!value) return null;
  const mapped = value.replace(/^::ffff:/i, '');
  return isIP(mapped) ? mapped : null;
}
