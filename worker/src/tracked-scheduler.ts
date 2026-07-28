export class TrackedScheduler {
  private readonly activeRuns = new Map<
    Promise<void>,
    AbortController
  >();
  private stopping = false;

  constructor(private readonly reportError: (error: unknown) => void) {}

  run(task: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.stopping) {
      return;
    }

    const controller = new AbortController();
    const run = Promise.resolve()
      .then(() => task(controller.signal))
      .then(
        () => {},
        (error: unknown) => {
          if (
            controller.signal.aborted &&
            error === controller.signal.reason
          ) {
            return;
          }
          try {
            this.reportError(error);
          } catch {
            // Error reporters must never turn an observed scheduler failure
            // into an unhandled rejection.
          }
        },
      );

    this.activeRuns.set(run, controller);
    void run.then(() => {
      this.activeRuns.delete(run);
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.activeRuns.values()) {
      controller.abort(new Error("Scheduler stopped"));
    }
    await Promise.all([...this.activeRuns.keys()]);
  }
}
