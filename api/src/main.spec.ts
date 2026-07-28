import {
  DEFAULT_HTTP_DRAIN_DELAY_MS,
  DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS,
  SUPPORTED_SHUTDOWN_SIGNALS,
  startApplicationLifecycle,
  type LifecycleApplication,
  type SignalRegistrar,
  type SupportedShutdownSignal,
} from './main';
import { ReadinessService } from './health/readiness.service';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

type TestLifecycleApplication = LifecycleApplication & {
  enableShutdownHooks: jest.Mock;
};

function createApp(
  overrides: Partial<TestLifecycleApplication> = {},
): TestLifecycleApplication {
  return {
    enableShutdownHooks: jest.fn(),
    listen: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function createReadiness(events: string[] = []) {
  return {
    markReady: jest.fn(() => events.push('ready')),
  };
}

function createRealReadiness() {
  const probe = {
    check: jest.fn<Promise<void>, []>().mockResolvedValue(undefined),
  };
  return new ReadinessService(probe, probe);
}

function createSignalRegistrar() {
  let handler: ((signal: SupportedShutdownSignal) => void) | undefined;
  let registeredSignals: readonly SupportedShutdownSignal[] = [];
  const unregister = jest.fn();
  const registerSignals: SignalRegistrar = (signals, nextHandler) => {
    registeredSignals = signals;
    handler = nextHandler;
    return unregister;
  };
  return {
    registerSignals,
    unregister,
    get registeredSignals() {
      return registeredSignals;
    },
    signal: (signal: SupportedShutdownSignal = 'SIGTERM') => {
      if (!handler) throw new Error('signal handler was not registered');
      handler(signal);
    },
  };
}

describe('startApplicationLifecycle', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('marks ready only after listen succeeds', async () => {
    const listening = deferred<void>();
    const app = createApp({
      listen: jest.fn(() => listening.promise),
    });
    const readiness = createReadiness();
    const signals = createSignalRegistrar();

    const started = startApplicationLifecycle(app, readiness, {
      port: 8888,
      registerSignals: signals.registerSignals,
    });

    expect(readiness.markReady).not.toHaveBeenCalled();

    listening.resolve();
    await started;

    expect(app.listen).toHaveBeenCalledWith({
      port: 8888,
      host: '0.0.0.0',
    });
    expect(readiness.markReady).toHaveBeenCalledTimes(1);
  });

  it('keeps readiness available while waiting for routing removal', async () => {
    jest.useFakeTimers();
    const events: string[] = [];
    const app = createApp({
      close: jest.fn().mockImplementation(() => {
        events.push('close');
        return Promise.resolve();
      }),
    });
    const readiness = createRealReadiness();
    const signals = createSignalRegistrar();
    const lifecycle = await startApplicationLifecycle(app, readiness, {
      port: 8888,
      drainDelayMs: 20,
      shutdownTimeoutMs: 50,
      registerSignals: signals.registerSignals,
    });

    signals.signal();

    await expect(readiness.check()).resolves.toEqual({ ready: true });
    expect(events).toEqual([]);
    await jest.advanceTimersByTimeAsync(19);
    expect(app.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await lifecycle.shutdown();

    expect(events).toEqual(['close']);
  });

  it('runs shutdown only once when multiple termination signals arrive', async () => {
    jest.useFakeTimers();
    const app = createApp();
    const readiness = createReadiness();
    const signals = createSignalRegistrar();
    const lifecycle = await startApplicationLifecycle(app, readiness, {
      port: 8888,
      drainDelayMs: 0,
      registerSignals: signals.registerSignals,
    });

    signals.signal();
    signals.signal();
    await jest.advanceTimersByTimeAsync(0);
    await lifecycle.shutdown();

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(signals.unregister).toHaveBeenCalledTimes(1);
  });

  it('routes mixed termination signals through the same shutdown promise', async () => {
    jest.useFakeTimers();
    const app = createApp();
    const readiness = createReadiness();
    const signals = createSignalRegistrar();
    const lifecycle = await startApplicationLifecycle(app, readiness, {
      port: 8888,
      drainDelayMs: 0,
      registerSignals: signals.registerSignals,
    });

    expect(signals.registeredSignals).toEqual(SUPPORTED_SHUTDOWN_SIGNALS);
    expect(app.enableShutdownHooks).not.toHaveBeenCalled();

    signals.signal('SIGHUP');
    signals.signal('SIGTERM');
    signals.signal('SIGINT');
    await jest.advanceTimersByTimeAsync(0);
    await lifecycle.shutdown();

    expect(app.close).toHaveBeenCalledTimes(1);
  });

  it('uses the default drain delay and forces completion at the hard deadline', async () => {
    jest.useFakeTimers();
    const app = createApp({
      close: jest.fn(() => new Promise<void>(() => undefined)),
    });
    const readiness = createReadiness();
    const signals = createSignalRegistrar();
    const forceExit = jest.fn();
    const lifecycle = await startApplicationLifecycle(app, readiness, {
      port: 8888,
      registerSignals: signals.registerSignals,
      forceExit,
    });

    signals.signal();
    await jest.advanceTimersByTimeAsync(DEFAULT_HTTP_DRAIN_DELAY_MS - 1);
    expect(app.close).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(forceExit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(DEFAULT_HTTP_SHUTDOWN_TIMEOUT_MS - 1);
    expect(forceExit).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await lifecycle.shutdown();

    expect(forceExit).toHaveBeenCalledWith(1);
  });

  it('completes shutdown deterministically when termination races pending listen', async () => {
    jest.useFakeTimers();
    const listening = deferred<void>();
    let listenResolved = false;
    const app = createApp({
      listen: jest.fn(() => listening.promise),
      close: jest.fn().mockImplementation(() => {
        expect(listenResolved).toBe(false);
        return Promise.resolve();
      }),
    });
    const readiness = createRealReadiness();
    const signals = createSignalRegistrar();

    const started = startApplicationLifecycle(app, readiness, {
      port: 8888,
      drainDelayMs: 0,
      registerSignals: signals.registerSignals,
    });
    let startupCompleted = false;
    const observeStartup = started.then(() => {
      startupCompleted = true;
    });

    signals.signal();
    await jest.advanceTimersByTimeAsync(0);

    expect(startupCompleted).toBe(false);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(signals.unregister).toHaveBeenCalledTimes(1);
    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: 'starting',
    });

    listenResolved = true;
    listening.resolve();
    const lifecycle = await started;
    await observeStartup;
    await lifecycle.shutdown();

    expect(app.close).toHaveBeenCalledTimes(1);
    await expect(readiness.check()).resolves.toEqual({
      ready: false,
      reason: 'starting',
    });
  });
});
