import { normalizeClientIp } from './client-ip';

describe('normalizeClientIp', () => {
  it('keeps a public IPv4 address', () => {
    expect(normalizeClientIp('203.0.113.40')).toBe('203.0.113.40');
  });

  it('keeps a public IPv6 address', () => {
    expect(normalizeClientIp('2001:db8::1')).toBe('2001:db8::1');
  });

  it('unwraps IPv4-mapped IPv6 so the timeline shows the v4 origin', () => {
    expect(normalizeClientIp('::ffff:198.51.100.20')).toBe('198.51.100.20');
  });

  it('rejects empty, spoofed lists, and non-IP values', () => {
    expect(normalizeClientIp(undefined)).toBeNull();
    expect(normalizeClientIp('')).toBeNull();
    expect(normalizeClientIp('not-an-ip')).toBeNull();
    expect(normalizeClientIp('203.0.113.40, 192.0.2.1')).toBeNull();
  });
});
