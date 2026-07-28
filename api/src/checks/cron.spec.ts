import {
  nextCronFire,
  minCronGapSeconds,
  isValidCron,
  isValidTz,
} from './cron';

describe('api cron helpers', () => {
  it('isValidCron accepts a valid expr and rejects garbage', () => {
    expect(isValidCron('0 3 * * *')).toBe(true);
    expect(isValidCron('not a cron')).toBe(false);
  });
  it('isValidTz accepts IANA zones and rejects garbage', () => {
    expect(isValidTz('America/Sao_Paulo')).toBe(true);
    expect(isValidTz('Mars/Phobos')).toBe(false);
  });
  it('minCronGapSeconds: every-minute cron => 60s', () => {
    expect(minCronGapSeconds('* * * * *', 'UTC')).toBe(60);
  });
  it('minCronGapSeconds: daily cron => 86400s', () => {
    expect(minCronGapSeconds('0 3 * * *', 'UTC')).toBe(86400);
  });
  it('nextCronFire returns the next fire after an instant', () => {
    const next = nextCronFire(
      '0 3 * * *',
      'UTC',
      new Date('2026-06-22T04:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-06-23T03:00:00.000Z');
  });
});
