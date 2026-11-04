import {
  aggregateOverview,
  AggregateCheck,
  AggregateInput,
  AggregateOutage,
  lateState,
} from './overview-aggregate';

const now = new Date('2026-11-04T10:00:00Z');
const rangeStart = new Date('2026-10-28T10:00:00Z');
const at = (iso: string) => new Date(iso);
const secondsAgo = (s: number) => new Date(now.getTime() - s * 1000);

let seq = 0;
function check(over: Partial<AggregateCheck> = {}): AggregateCheck {
  seq += 1;
  return {
    id: `c${seq}`,
    organizationId: 'org-a',
    type: 'HEARTBEAT',
    status: 'UP',
    createdAt: at('2026-01-01T00:00:00Z'),
    lastEventAt: secondsAgo(60),
    periodSeconds: 300,
    graceSeconds: 60,
    schedule: null,
    tz: null,
    ...over,
  };
}

function input(over: Partial<AggregateInput> = {}): AggregateInput {
  return {
    now,
    rangeStart,
    bucketStarts: [rangeStart],
    organizationIds: ['org-a'],
    checks: [],
    outages: [],
    ...over,
  };
}

function closed(
  checkId: string,
  start: Date,
  seconds: number,
): AggregateOutage {
  return {
    checkId,
    startedAt: start,
    endedAt: new Date(start.getTime() + seconds * 1000),
  };
}

describe('aggregateOverview', () => {
  it('uses the unclipped start for needs-fixing but clips totals', () => {
    const c = check({ status: 'DOWN' });
    const result = aggregateOverview(
      input({
        checks: [c],
        outages: [
          {
            checkId: c.id,
            startedAt: at('2026-10-27T10:00:00Z'),
            endedAt: null,
          },
        ],
      }),
    );
    expect(result.needsFixing[0].since).toEqual(at('2026-10-27T10:00:00Z'));
    expect(result.summary.brokenSeconds).toBe(604800);
    expect(result.checks[0].ongoing).toBe(true);
    expect(result.checks[0].outages[0]).toEqual({
      startedAt: rangeStart,
      endedAt: null,
    });
  });

  it('orders DOWN oldest first, then LATE most overdue first, and skips PAUSED and NEW', () => {
    const down09 = check({ status: 'DOWN' });
    const down07 = check({ status: 'DOWN' });
    const late0945 = check({
      lastEventAt: at('2026-11-04T09:45:00Z'),
      periodSeconds: 600,
    });
    const late0940 = check({
      lastEventAt: at('2026-11-04T09:40:00Z'),
      periodSeconds: 600,
    });
    const paused = check({ status: 'PAUSED' });
    const fresh = check({ status: 'NEW', lastEventAt: null });
    const result = aggregateOverview(
      input({
        checks: [late0945, down09, paused, late0940, fresh, down07],
        outages: [
          {
            checkId: down09.id,
            startedAt: at('2026-11-04T09:00:00Z'),
            endedAt: null,
          },
          {
            checkId: down07.id,
            startedAt: at('2026-11-04T07:00:00Z'),
            endedAt: null,
          },
        ],
      }),
    );
    expect(result.needsFixing.map((e) => e.checkId)).toEqual([
      down07.id,
      down09.id,
      late0940.id,
      late0945.id,
    ]);
    expect(result.needsFixing[2]).toMatchObject({
      state: 'LATE',
      since: at('2026-11-04T09:50:00Z'),
      downAt: at('2026-11-04T09:51:00Z'),
    });
  });

  it('starts monitored time at createdAt', () => {
    const c = check({ status: 'DOWN', createdAt: secondsAgo(3600) });
    const result = aggregateOverview(
      input({
        checks: [c],
        outages: [
          { checkId: c.id, startedAt: secondsAgo(1800), endedAt: null },
        ],
      }),
    );
    expect(result.summary.uptimePercent).toBeCloseTo(50, 5);
    expect(result.checks[0].uptimePercent).toBeCloseTo(50, 5);
  });

  it('excludes PAUSED and never-reported checks from uptime', () => {
    const paused = check({ status: 'PAUSED' });
    const fresh = check({ status: 'NEW', lastEventAt: null });
    const result = aggregateOverview(input({ checks: [paused, fresh] }));
    expect(result.summary.uptimePercent).toBeNull();

    const healthy = check();
    const mixed = aggregateOverview(
      input({ checks: [paused, fresh, healthy] }),
    );
    expect(mixed.summary.uptimePercent).toBe(100);
  });

  it('returns nulls when there is nothing to measure', () => {
    const result = aggregateOverview(input({ organizationIds: [] }));
    expect(result.summary.uptimePercent).toBeNull();
    expect(result.summary.medianOutageSeconds).toBeNull();
    expect(result.summary.longestOutageCheckId).toBeNull();
    expect(result.summary.brokenSeconds).toBe(0);
    expect(result.byOrganization).toEqual([]);
  });

  it('computes the median over clipped durations', () => {
    const cs = [check(), check(), check(), check()];
    const durations = [60, 120, 300, 900];
    const result = aggregateOverview(
      input({
        checks: cs,
        outages: cs.map((c, i) =>
          closed(c.id, at(`2026-11-0${i + 1}T00:00:00Z`), durations[i]),
        ),
      }),
    );
    expect(result.summary.medianOutageSeconds).toBe(210);
    expect(result.summary.longestOutageCheckId).toBe(cs[3].id);
    expect(result.summary.outageCount).toBe(4);
    expect(result.summary.ongoingCount).toBe(0);
  });

  it('contributes 0 seconds for an outage that ends before it starts', () => {
    const c = check();
    const start = at('2026-11-03T00:00:00Z');
    const run = () =>
      aggregateOverview(
        input({
          checks: [c],
          outages: [
            {
              checkId: c.id,
              startedAt: start,
              endedAt: new Date(start.getTime() - 5000),
            },
          ],
        }),
      );
    expect(run).not.toThrow();
    const result = run();
    expect(result.summary.brokenSeconds).toBe(0);
    expect(result.checks[0].brokenSeconds).toBe(0);
    expect(result.checks[0].longestOutageSeconds).toBe(0);
    expect(result.buckets[0].brokenSeconds).toBe(0);
    expect(result.byOrganization[0].brokenSeconds).toBe(0);
  });

  it('splits outage time across buckets and clips the first bucket', () => {
    const c = check();
    const bucketStarts = [
      '2026-10-28T00:00:00Z',
      '2026-10-29T00:00:00Z',
      '2026-10-30T00:00:00Z',
      '2026-10-31T00:00:00Z',
      '2026-11-01T00:00:00Z',
      '2026-11-02T00:00:00Z',
      '2026-11-03T00:00:00Z',
      '2026-11-04T00:00:00Z',
    ].map(at);
    const result = aggregateOverview(
      input({
        bucketStarts,
        checks: [c],
        outages: [
          {
            checkId: c.id,
            startedAt: at('2026-10-28T00:00:00Z'),
            endedAt: at('2026-10-28T12:00:00Z'),
          },
          closed(c.id, at('2026-11-02T23:00:00Z'), 7200),
        ],
      }),
    );
    expect(result.buckets.map((b) => b.start)).toEqual(bucketStarts);
    expect(result.buckets[0].brokenSeconds).toBe(7200); // 10:00 -> 12:00
    expect(result.buckets[5].brokenSeconds).toBe(3600);
    expect(result.buckets[6].brokenSeconds).toBe(3600);
    expect(result.buckets[7].brokenSeconds).toBe(0);
  });

  it('lists every organization including zero, broken time desc', () => {
    const a = check({ organizationId: 'org-a' });
    const b = check({ organizationId: 'org-b' });
    const result = aggregateOverview(
      input({
        organizationIds: ['org-a', 'org-b', 'org-c'],
        checks: [a, b],
        outages: [
          closed(b.id, at('2026-11-01T00:00:00Z'), 600),
          closed(b.id, at('2026-11-02T00:00:00Z'), 600),
        ],
      }),
    );
    expect(result.byOrganization).toEqual([
      { organizationId: 'org-b', brokenSeconds: 1200, outageCount: 2 },
      { organizationId: 'org-a', brokenSeconds: 0, outageCount: 0 },
      { organizationId: 'org-c', brokenSeconds: 0, outageCount: 0 },
    ]);
  });
});

describe('lateState', () => {
  it('marks a period heartbeat late after nextExpectedAt and keeps it late past downAt', () => {
    const c = check({
      lastEventAt: secondsAgo(400),
      periodSeconds: 300,
      graceSeconds: 60,
    });
    const state = lateState(c, now);
    expect(state).not.toBeNull();
    expect(state!.since).toEqual(secondsAgo(100));
    expect(state!.downAt).toEqual(secondsAgo(40));
  });

  it('marks a cron heartbeat late from the next fire after lastEventAt', () => {
    const c = check({
      schedule: '0 * * * *',
      tz: 'UTC',
      lastEventAt: at('2026-11-04T08:30:00Z'),
    });
    expect(lateState(c, now)!.since).toEqual(at('2026-11-04T09:00:00Z'));
  });

  it('is not late before the expected time', () => {
    expect(lateState(check(), now)).toBeNull();
  });

  it('never marks HTTP or TCP checks late', () => {
    for (const type of ['HTTP', 'TCP']) {
      const c = check({ type, lastEventAt: secondsAgo(100000) });
      expect(lateState(c, now)).toBeNull();
    }
  });
});
