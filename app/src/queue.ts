/**
 * Runs one job at a time per key and folds repeats together: a request that
 * arrives while its key is running makes it run once more afterwards, however
 * many arrive. CI finishing fires several webhooks for the same PR at once.
 */
export class KeyedQueue {
  private readonly running = new Map<string, { again: boolean }>();
  private readonly settled = new Set<() => void>();

  constructor(private readonly onError: (key: string, error: unknown) => void) {}

  run(key: string, job: () => Promise<void>): void {
    const current = this.running.get(key);
    if (current) {
      current.again = true;
      return;
    }
    const state = { again: false };
    this.running.set(key, state);
    void (async () => {
      do {
        state.again = false;
        try {
          await job();
        } catch (error) {
          this.onError(key, error);
        }
      } while (state.again);
      this.running.delete(key);
      if (this.running.size === 0) {
        for (const resolve of this.settled) resolve();
        this.settled.clear();
      }
    })();
  }

  /** Resolves once nothing is running. */
  idle(): Promise<void> {
    if (this.running.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.settled.add(resolve));
  }
}
