/**
 * How often the check surfaces re-query while the tab is in the foreground.
 *
 * Matched to the worker's probe scheduler tick. The watchdog only sweeps every
 * 30s, so no check status can change faster than that and a shorter interval
 * would buy nothing but load.
 */
export const CHECK_POLL_INTERVAL_MS = 15_000;
