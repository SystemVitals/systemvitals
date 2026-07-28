import {
  resolveCheckUpdate,
  CheckValidationError,
  type CurrentCheck,
} from './check-update';

const HEARTBEAT: CurrentCheck = {
  type: 'HEARTBEAT',
  pingSlug: 'existing-ping-slug',
  periodSeconds: 300,
  graceSeconds: 60,
  schedule: null,
  tz: null,
  target: null,
  method: null,
  expectedStatus: null,
  intervalSeconds: null,
  timeoutMs: null,
};

const HTTP: CurrentCheck = {
  type: 'HTTP',
  pingSlug: null,
  periodSeconds: null,
  graceSeconds: null,
  schedule: null,
  tz: null,
  target: 'https://example.com/health',
  method: 'GET',
  expectedStatus: 200,
  intervalSeconds: 300,
  timeoutMs: 5000,
};

const HEARTBEAT_CRON: CurrentCheck = {
  type: 'HEARTBEAT',
  pingSlug: 'existing-ping-slug',
  periodSeconds: null,
  graceSeconds: 60,
  schedule: '0 3 * * *',
  tz: 'UTC',
  target: null,
  method: null,
  expectedStatus: null,
  intervalSeconds: null,
  timeoutMs: null,
};

describe('resolveCheckUpdate', () => {
  describe('without a type change', () => {
    it('applies only the keys provided', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, { name: 'Renamed' });
      expect(data.name).toBe('Renamed');
      expect(data.periodSeconds).toBe(300);
      expect(data.graceSeconds).toBe(60);
    });

    it('leaves the other mode untouched rather than nulling it', () => {
      const { data } = resolveCheckUpdate(HTTP, { timeoutMs: 9000 });
      expect(data.timeoutMs).toBe(9000);
      expect(data.target).toBe('https://example.com/health');
      expect(data.type).toBe('HTTP');
    });

    it('validates the plan floor against the heartbeat period', () => {
      const { intervalToValidate } = resolveCheckUpdate(HEARTBEAT, {
        periodSeconds: 120,
      });
      expect(intervalToValidate).toBe(120);
    });
  });

  describe('HEARTBEAT -> HTTP', () => {
    const input = {
      type: 'HTTP',
      target: 'https://example.com/up',
      intervalSeconds: 300,
      timeoutMs: 5000,
    };

    it('nulls every heartbeat column so the watchdog cannot act on it', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, input);
      expect(data.periodSeconds).toBeNull();
      expect(data.graceSeconds).toBeNull();
      expect(data.schedule).toBeNull();
      expect(data.tz).toBeNull();
    });

    it('keeps the existing ping slug dormant rather than minting a new one', () => {
      const { data, mintPingSlug } = resolveCheckUpdate(HEARTBEAT, input);
      expect(mintPingSlug).toBe(false);
      expect(data.pingSlug).toBeUndefined();
    });

    it('defaults the HTTP method to GET', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, input);
      expect(data.method).toBe('GET');
    });

    it('requires the fields the new mode needs', () => {
      expect(() => resolveCheckUpdate(HEARTBEAT, { type: 'HTTP' })).toThrow(
        CheckValidationError,
      );
    });

    it('rejects a target that is not an http(s) URL', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, { ...input, target: 'example.com' }),
      ).toThrow(/http:\/\/ or https:\/\//);
    });

    it('reports the new interval for plan validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(HEARTBEAT, input);
      expect(intervalToValidate).toBe(300);
    });
  });

  describe('HEARTBEAT -> TCP', () => {
    it('requires host:port', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'TCP',
          target: 'example.com',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/host:port/);
    });

    it('carries no method or expected status', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, {
        type: 'TCP',
        target: 'example.com:5432',
        intervalSeconds: 300,
        timeoutMs: 5000,
      });
      expect(data.method).toBeNull();
      expect(data.expectedStatus).toBeNull();
    });
  });

  describe('HTTP -> HEARTBEAT', () => {
    const input = { type: 'HEARTBEAT', periodSeconds: 600, graceSeconds: 60 };

    it('nulls every active column', () => {
      const { data } = resolveCheckUpdate(HTTP, input);
      expect(data.target).toBeNull();
      expect(data.method).toBeNull();
      expect(data.expectedStatus).toBeNull();
      expect(data.intervalSeconds).toBeNull();
      expect(data.timeoutMs).toBeNull();
    });

    it('mints a ping slug when the check never had one', () => {
      const { mintPingSlug } = resolveCheckUpdate(HTTP, input);
      expect(mintPingSlug).toBe(true);
    });

    it('reuses a dormant ping slug when one survives', () => {
      const converted = { ...HTTP, pingSlug: 'dormant-slug' };
      const { mintPingSlug } = resolveCheckUpdate(converted, input);
      expect(mintPingSlug).toBe(false);
    });

    it('requires exactly one of periodSeconds or schedule', () => {
      expect(() =>
        resolveCheckUpdate(HTTP, { type: 'HEARTBEAT', graceSeconds: 60 }),
      ).toThrow(/exactly one/);

      expect(() =>
        resolveCheckUpdate(HTTP, {
          type: 'HEARTBEAT',
          graceSeconds: 60,
          periodSeconds: 300,
          schedule: '0 3 * * *',
        }),
      ).toThrow(/exactly one/);
    });

    it('requires a grace period', () => {
      expect(() =>
        resolveCheckUpdate(HTTP, { type: 'HEARTBEAT', periodSeconds: 300 }),
      ).toThrow(/graceSeconds/);
    });

    it('accepts a cron schedule and defaults the timezone to UTC', () => {
      const { data } = resolveCheckUpdate(HTTP, {
        type: 'HEARTBEAT',
        schedule: '0 3 * * *',
        graceSeconds: 60,
      });
      expect(data.schedule).toBe('0 3 * * *');
      expect(data.tz).toBe('UTC');
      expect(data.periodSeconds).toBeNull();
    });

    it('rejects an invalid cron expression', () => {
      expect(() =>
        resolveCheckUpdate(HTTP, {
          type: 'HEARTBEAT',
          schedule: 'not a cron',
          graceSeconds: 60,
        }),
      ).toThrow(/cron/i);
    });

    it('rejects an invalid timezone', () => {
      expect(() =>
        resolveCheckUpdate(HTTP, {
          type: 'HEARTBEAT',
          schedule: '0 3 * * *',
          tz: 'Mars/Olympus',
          graceSeconds: 60,
        }),
      ).toThrow(/timezone/i);
    });

    it('validates the plan floor against the tightest cron gap', () => {
      const { intervalToValidate } = resolveCheckUpdate(HTTP, {
        type: 'HEARTBEAT',
        schedule: '*/5 * * * *',
        graceSeconds: 60,
      });
      expect(intervalToValidate).toBe(300);
    });
  });

  describe('rejected types', () => {
    it('rejects PING, which has no prober', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'PING',
          target: 'example.com',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/HEARTBEAT, HTTP or TCP/);
    });

    it('rejects an unknown type', () => {
      expect(() => resolveCheckUpdate(HEARTBEAT, { type: 'GOPHER' })).toThrow(
        CheckValidationError,
      );
    });
  });

  describe('name', () => {
    it('rejects a blank name', () => {
      expect(() => resolveCheckUpdate(HEARTBEAT, { name: '   ' })).toThrow(
        /name/i,
      );
    });

    it('trims a provided name', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, { name: '  Padded  ' });
      expect(data.name).toBe('Padded');
    });

    it('raises a validation error instead of crashing on an explicit null name', () => {
      // The GraphQL field is a nullable String, so a client can send an
      // explicit null even though the TypeScript type says `string | undefined`.
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          name: null as unknown as string,
        }),
      ).toThrow(CheckValidationError);

      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          name: null as unknown as string,
        }),
      ).toThrow(/name/i);
    });
  });

  describe('heartbeat mode switching without a type change', () => {
    it('switches period-mode to cron-mode when the caller supplies only a schedule', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, {
        schedule: '0 3 * * *',
      });
      expect(data.schedule).toBe('0 3 * * *');
      expect(data.tz).toBe('UTC');
      expect(data.periodSeconds).toBeNull();
    });

    it('switches cron-mode to period-mode when the caller supplies only periodSeconds', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT_CRON, {
        periodSeconds: 120,
      });
      expect(data.periodSeconds).toBe(120);
      expect(data.schedule).toBeNull();
      expect(data.tz).toBeNull();
    });

    it('still rejects when both periodSeconds and schedule are supplied, with no type change', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          periodSeconds: 300,
          schedule: '0 3 * * *',
        }),
      ).toThrow(/exactly one/);
    });

    it('still inherits the stored mode on a plain edit that touches neither field', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT_CRON, {
        graceSeconds: 90,
      });
      expect(data.schedule).toBe('0 3 * * *');
      expect(data.tz).toBe('UTC');
      expect(data.periodSeconds).toBeNull();
      expect(data.graceSeconds).toBe(90);
    });

    it('treats an empty-string schedule as not supplying a schedule, consistent with hasCron', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, { schedule: '' });
      expect(data.periodSeconds).toBe(300);
      expect(data.schedule).toBeNull();
    });
  });

  describe('an explicit null type', () => {
    it('treats null type identically to omitting type on an HTTP check', () => {
      const withNull = resolveCheckUpdate(HTTP, {
        type: null as unknown as string,
        timeoutMs: 9000,
      });
      const withoutType = resolveCheckUpdate(HTTP, {
        timeoutMs: 9000,
      });
      expect(withNull.data).toEqual(withoutType.data);
    });

    it('treats null type identically to omitting type on a HEARTBEAT check', () => {
      const withNull = resolveCheckUpdate(HEARTBEAT, {
        type: null as unknown as string,
        periodSeconds: 120,
      });
      const withoutType = resolveCheckUpdate(HEARTBEAT, {
        periodSeconds: 120,
      });
      expect(withNull.data).toEqual(withoutType.data);
    });
  });

  describe('converting INTO HEARTBEAT resets status (Fix 4)', () => {
    it('resets status to NEW and lastEventAt to null on HTTP -> HEARTBEAT', () => {
      const { data } = resolveCheckUpdate(HTTP, {
        type: 'HEARTBEAT',
        periodSeconds: 300,
        graceSeconds: 60,
      });
      expect(data.status).toBe('NEW');
      expect(data.lastEventAt).toBeNull();
    });

    it('resets status to NEW and lastEventAt to null on TCP -> HEARTBEAT', () => {
      const TCP: CurrentCheck = {
        ...HTTP,
        type: 'TCP',
        target: 'example.com:5432',
        method: null,
        expectedStatus: null,
      };
      const { data } = resolveCheckUpdate(TCP, {
        type: 'HEARTBEAT',
        schedule: '0 3 * * *',
        graceSeconds: 60,
      });
      expect(data.status).toBe('NEW');
      expect(data.lastEventAt).toBeNull();
    });

    it('does NOT touch status or lastEventAt on a plain heartbeat edit (no type change)', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, { graceSeconds: 90 });
      expect(data.status).toBeUndefined();
      expect(data.lastEventAt).toBeUndefined();
    });

    it('does NOT touch status or lastEventAt on a mode switch that is not a type change', () => {
      // period-mode -> cron-mode is a plain edit, not a conversion — the
      // outer `isConversion` flag stays false.
      const { data } = resolveCheckUpdate(HEARTBEAT, {
        schedule: '0 3 * * *',
      });
      expect(data.status).toBeUndefined();
      expect(data.lastEventAt).toBeUndefined();
    });

    it('does NOT touch status or lastEventAt when converting HEARTBEAT -> HTTP (only the inbound direction is special-cased)', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, {
        type: 'HTTP',
        target: 'https://example.com/up',
        intervalSeconds: 300,
        timeoutMs: 5000,
      });
      expect(data.status).toBeUndefined();
      expect(data.lastEventAt).toBeUndefined();
    });
  });

  describe('plan-floor re-validation only on an actual change (Fix 5)', () => {
    const BELOW_FLOOR_HEARTBEAT: CurrentCheck = {
      ...HEARTBEAT,
      periodSeconds: 60, // below a hypothetical 300s FREE floor
    };

    const BELOW_FLOOR_HTTP: CurrentCheck = {
      ...HTTP,
      intervalSeconds: 60,
    };

    const BELOW_FLOOR_CRON_HEARTBEAT: CurrentCheck = {
      ...HEARTBEAT_CRON,
      schedule: '* * * * *', // 60s gap
    };

    const BELOW_FLOOR_SECONDS_CRON_HEARTBEAT: CurrentCheck = {
      ...HEARTBEAT_CRON,
      schedule: '*/30 * * * * *',
      tz: 'UTC',
    };

    it('a rename on a below-floor heartbeat does not re-trigger validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(BELOW_FLOOR_HEARTBEAT, {
        name: 'New name',
      });
      expect(intervalToValidate).toBeNull();
    });

    it('lowering a below-floor heartbeat interval further still re-triggers validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(BELOW_FLOOR_HEARTBEAT, {
        periodSeconds: 30,
      });
      expect(intervalToValidate).toBe(30);
    });

    it('re-supplying the same period explicitly is a no-op for validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(BELOW_FLOOR_HEARTBEAT, {
        periodSeconds: 60,
      });
      expect(intervalToValidate).toBeNull();
    });

    it('a rename on a below-floor cron heartbeat does not re-trigger validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(
        BELOW_FLOOR_CRON_HEARTBEAT,
        { name: 'New name' },
      );
      expect(intervalToValidate).toBeNull();
    });

    it('tightening a below-floor cron heartbeat still re-triggers validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(
        BELOW_FLOOR_CRON_HEARTBEAT,
        { schedule: '*/2 * * * *' }, // widens the gap, still a change
      );
      expect(intervalToValidate).toBe(120);
    });

    it('changing a cron expression re-triggers validation when its minimum gap is unchanged', () => {
      const { intervalToValidate } = resolveCheckUpdate(
        BELOW_FLOOR_SECONDS_CRON_HEARTBEAT,
        { schedule: '15,45 * * * * *' },
      );
      expect(intervalToValidate).toBe(30);
    });

    it('changing a cron timezone re-triggers validation when its minimum gap is unchanged', () => {
      const { intervalToValidate } = resolveCheckUpdate(
        BELOW_FLOOR_SECONDS_CRON_HEARTBEAT,
        { tz: 'America/Sao_Paulo' },
      );
      expect(intervalToValidate).toBe(30);
    });

    it('switching from cron to the same-gap period re-triggers validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(
        BELOW_FLOOR_SECONDS_CRON_HEARTBEAT,
        { periodSeconds: 30 },
      );
      expect(intervalToValidate).toBe(30);
    });

    it('exactly re-supplying a cron cadence does not re-trigger validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(
        BELOW_FLOOR_SECONDS_CRON_HEARTBEAT,
        {
          schedule: '*/30 * * * * *',
          tz: 'UTC',
        },
      );
      expect(intervalToValidate).toBeNull();
    });

    it('a rename on a below-floor active (HTTP) check does not re-trigger validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(BELOW_FLOOR_HTTP, {
        name: 'New name',
      });
      expect(intervalToValidate).toBeNull();
    });

    it('lowering a below-floor active check interval further still re-triggers validation', () => {
      const { intervalToValidate } = resolveCheckUpdate(BELOW_FLOOR_HTTP, {
        intervalSeconds: 10,
      });
      expect(intervalToValidate).toBe(10);
    });

    it('still validates unconditionally on a real type conversion, even to the same numeric interval', () => {
      const { intervalToValidate } = resolveCheckUpdate(BELOW_FLOOR_HTTP, {
        type: 'TCP',
        target: 'example.com:5432',
        intervalSeconds: 60, // same number, but this is a conversion
        timeoutMs: 5000,
      });
      expect(intervalToValidate).toBe(60);
    });
  });

  describe('TCP target validation is tightened against URL-shaped targets (Fix 6)', () => {
    it('rejects an HTTP(S) URL masquerading as host:port', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'TCP',
          target: 'https://example.com',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/host:port/);
    });

    it('rejects a target with no port', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'TCP',
          target: 'example.com',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/host:port/);
    });

    it('rejects a non-numeric port', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'TCP',
          target: 'example.com:https',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/host:port/);
    });

    it('rejects an empty host', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'TCP',
          target: ':5432',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/host:port/);
    });

    it('rejects a port out of range', () => {
      expect(() =>
        resolveCheckUpdate(HEARTBEAT, {
          type: 'TCP',
          target: 'example.com:99999',
          intervalSeconds: 300,
          timeoutMs: 5000,
        }),
      ).toThrow(/host:port/);
    });

    it('accepts a legitimate host:port target', () => {
      const { data } = resolveCheckUpdate(HEARTBEAT, {
        type: 'TCP',
        target: 'example.com:5432',
        intervalSeconds: 300,
        timeoutMs: 5000,
      });
      expect(data.target).toBe('example.com:5432');
    });
  });
});
