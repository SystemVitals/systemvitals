import type { Prisma } from '@systemvitals/database';
import { isValidCron, isValidTz, minCronGapSeconds } from './cron';
import { isValidSlug } from '../common/slug';

export class CheckValidationError extends Error {}

export type EditableCheckType = 'HEARTBEAT' | 'HTTP' | 'TCP';

const EDITABLE_TYPES: readonly EditableCheckType[] = [
  'HEARTBEAT',
  'HTTP',
  'TCP',
];

function isEditableCheckType(value: string): value is EditableCheckType {
  return (EDITABLE_TYPES as readonly string[]).includes(value);
}

export interface CheckUpdateInput {
  name?: string;
  slug?: string;
  type?: string;
  periodSeconds?: number;
  graceSeconds?: number;
  schedule?: string;
  tz?: string;
  target?: string;
  method?: string;
  expectedStatus?: number;
  intervalSeconds?: number;
  timeoutMs?: number;
}

export interface CurrentCheck {
  type: string;
  pingSlug: string | null;
  periodSeconds: number | null;
  graceSeconds: number | null;
  schedule: string | null;
  tz: string | null;
  target: string | null;
  method: string | null;
  expectedStatus: number | null;
  intervalSeconds: number | null;
  timeoutMs: number | null;
}

export interface ResolvedCheckUpdate {
  data: Prisma.CheckUpdateInput;
  intervalToValidate: number | null;
  mintPingSlug: boolean;
}

/**
 * On a type change the incoming mode starts from a clean slate: values are
 * taken only from the input, never inherited from the mode being left behind.
 * Without a type change, an absent key keeps the stored value.
 */
function pick<T>(
  provided: T | undefined,
  stored: T | null,
  isConversion: boolean,
): T | null {
  if (provided !== undefined) return provided;
  return isConversion ? null : stored;
}

export function resolveCheckUpdate(
  current: CurrentCheck,
  input: CheckUpdateInput,
): ResolvedCheckUpdate {
  const requestedType = input.type ?? current.type;

  if (!isEditableCheckType(requestedType)) {
    throw new CheckValidationError(
      `Check type must be HEARTBEAT, HTTP or TCP; got ${requestedType}.`,
    );
  }
  const targetType = requestedType;

  const isConversion = targetType !== current.type;
  const data: Prisma.CheckUpdateInput = { type: targetType };

  if (input.name !== undefined) {
    // `name` is typed as `string | undefined`, but the GraphQL field is a
    // nullable String — a client can send an explicit null at runtime even
    // though the TypeScript type promises otherwise. Guard defensively
    // instead of trusting the type.
    const rawName: unknown = input.name;
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name) throw new CheckValidationError('Check name cannot be empty');
    data.name = name;
  }

  if (input.slug !== undefined) {
    if (typeof input.slug !== 'string' || !isValidSlug(input.slug)) {
      throw new CheckValidationError(
        'Slug must be lowercase letters, numbers and single hyphens',
      );
    }
    data.slug = input.slug;
  }

  if (targetType === 'HEARTBEAT') {
    return resolveHeartbeat(current, input, data, isConversion);
  }
  return resolveActive(current, input, data, isConversion, targetType);
}

function resolveHeartbeat(
  current: CurrentCheck,
  input: CheckUpdateInput,
  data: Prisma.CheckUpdateInput,
  isConversion: boolean,
): ResolvedCheckUpdate {
  // `schedule: ''` is treated as "not supplied", consistent with `hasCron`
  // below. When the caller explicitly supplies exactly one of
  // periodSeconds/schedule, that mode wins and the sibling column is
  // cleared — with or without a type change, so an existing heartbeat can
  // switch between period-mode and cron-mode on a plain edit. When both are
  // supplied, keep rejecting. When neither is supplied, fall back to the
  // conversion-aware inherit/clear behaviour of `pick`.
  const explicitPeriod = input.periodSeconds !== undefined;
  const explicitSchedule =
    input.schedule !== undefined && input.schedule !== '';

  let periodSeconds: number | null;
  let schedule: string | null;

  if (explicitPeriod && explicitSchedule) {
    throw new CheckValidationError(
      'Provide exactly one of periodSeconds or schedule',
    );
  } else if (explicitPeriod || explicitSchedule) {
    periodSeconds = explicitPeriod ? (input.periodSeconds as number) : null;
    schedule = explicitSchedule ? (input.schedule as string) : null;
  } else {
    periodSeconds = pick(
      input.periodSeconds,
      current.periodSeconds,
      isConversion,
    );
    schedule = pick(input.schedule, current.schedule, isConversion);
  }

  const graceSeconds = pick(
    input.graceSeconds,
    current.graceSeconds,
    isConversion,
  );

  const cronExpr =
    typeof schedule === 'string' && schedule.length > 0 ? schedule : null;
  const hasPeriod = periodSeconds !== null;
  const hasCron = cronExpr !== null;
  if (hasPeriod === hasCron) {
    throw new CheckValidationError(
      'Provide exactly one of periodSeconds or schedule',
    );
  }
  if (graceSeconds === null) {
    throw new CheckValidationError(
      'graceSeconds is required for a heartbeat check',
    );
  }

  let newInterval: number;
  let cadenceChanged: boolean;
  if (cronExpr !== null) {
    if (!isValidCron(cronExpr)) {
      throw new CheckValidationError('Invalid cron expression');
    }
    const zone = pick(input.tz, current.tz, isConversion) || 'UTC';
    if (!isValidTz(zone)) throw new CheckValidationError('Invalid timezone');
    data.schedule = cronExpr;
    data.tz = zone;
    data.periodSeconds = null;
    newInterval = minCronGapSeconds(cronExpr, zone);
    cadenceChanged =
      current.schedule !== cronExpr || (current.tz || 'UTC') !== zone;
  } else {
    if (periodSeconds === null) {
      throw new CheckValidationError(
        'Provide exactly one of periodSeconds or schedule',
      );
    }
    data.periodSeconds = periodSeconds;
    data.schedule = null;
    data.tz = null;
    newInterval = periodSeconds;
    cadenceChanged =
      current.schedule !== null || current.periodSeconds !== periodSeconds;
  }

  data.graceSeconds = graceSeconds;
  // The active mode's columns must not survive; the probe scheduler keys off
  // type, but stale target/interval values are a trap for later readers.
  data.target = null;
  data.method = null;
  data.expectedStatus = null;
  data.intervalSeconds = null;
  data.timeoutMs = null;

  if (isConversion) {
    // `create` deliberately starts a heartbeat at status:'NEW' with
    // lastEventAt:null — that is what stops `watchdog.ts` (which requires
    // lastEventAt IS NOT NULL) sweeping it before the first ping arrives.
    // Converting INTO heartbeat must match that, or the probe regime's
    // leftover status:'UP' + recent lastEventAt sails straight into the
    // overdue window and the watchdog fires a false "missed heartbeat"
    // before the user has even finished wiring up the new ping URL. A plain
    // edit of an already-heartbeat check (isConversion false) must NOT hit
    // this — status/lastEventAt stay exactly as they are for that case.
    data.status = 'NEW';
    data.lastEventAt = null;
  }

  return {
    data,
    intervalToValidate: isConversion || cadenceChanged ? newInterval : null,
    mintPingSlug: current.pingSlug === null,
  };
}

function resolveActive(
  current: CurrentCheck,
  input: CheckUpdateInput,
  data: Prisma.CheckUpdateInput,
  isConversion: boolean,
  targetType: string,
): ResolvedCheckUpdate {
  const target = pick(input.target, current.target, isConversion);
  const intervalSeconds = pick(
    input.intervalSeconds,
    current.intervalSeconds,
    isConversion,
  );
  const timeoutMs = pick(input.timeoutMs, current.timeoutMs, isConversion);

  if (target === null || target === '') {
    throw new CheckValidationError(
      `target is required for a ${targetType} check`,
    );
  }
  if (intervalSeconds === null) {
    throw new CheckValidationError(
      `intervalSeconds is required for a ${targetType} check`,
    );
  }
  if (timeoutMs === null) {
    throw new CheckValidationError(
      `timeoutMs is required for a ${targetType} check`,
    );
  }

  if (targetType === 'HTTP') {
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      throw new CheckValidationError(
        'HTTP target must be a valid URL starting with http:// or https://',
      );
    }
    data.method = pick(input.method, current.method, isConversion) ?? 'GET';
    data.expectedStatus = pick(
      input.expectedStatus,
      current.expectedStatus,
      isConversion,
    );
  } else {
    if (!isValidTcpTarget(target)) {
      throw new CheckValidationError(
        'TCP target must be in host:port format (e.g. example.com:5432), not a URL',
      );
    }
    data.method = null;
    data.expectedStatus = null;
  }

  data.target = target;
  data.intervalSeconds = intervalSeconds;
  data.timeoutMs = timeoutMs;
  data.periodSeconds = null;
  data.graceSeconds = null;
  data.schedule = null;
  data.tz = null;

  return {
    data,
    intervalToValidate: isConversion
      ? intervalSeconds
      : validateIfChanged(intervalSeconds, current.intervalSeconds),
    mintPingSlug: false,
  };
}

/**
 * `host:port` only — no URL scheme (`https://example.com` must not pass just
 * because it contains a colon), a non-empty host, and a numeric port in
 * range. Mirrors how `worker/src/prober.ts` actually parses a TCP target
 * (`lastIndexOf(":")`), so a target that passes here is one the prober can
 * actually connect with.
 */
function isValidTcpTarget(target: string): boolean {
  if (target.includes('://')) return false;
  const lastColon = target.lastIndexOf(':');
  if (lastColon <= 0) return false;
  const host = target.slice(0, lastColon);
  const portStr = target.slice(lastColon + 1);
  if (!host || !/^\d+$/.test(portStr)) return false;
  const port = Number(portStr);
  return port >= 1 && port <= 65535;
}

/**
 * A conversion always re-validates (the check is entering the active regime
 * fresh, or the plan floor may never have been checked for it before). A
 * plain edit only needs to re-validate when the effective interval actually
 * moved — otherwise every unrelated field edit (e.g. a rename) on a check
 * whose stored interval already sits below a since-downgraded plan floor
 * would be rejected, even though nothing about the interval changed.
 */
function validateIfChanged(
  newInterval: number,
  previousInterval: number | null,
): number | null {
  return newInterval === previousInterval ? null : newInterval;
}
