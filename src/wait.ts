// Two async-readiness primitives that consolidate the polling and retry
// patterns repeated across `examples/` and `tutorials/`. Both share one
// `WaitTimeout` error type and one deadline/interval semantic so a
// caller learns the contract once.
//
//   waitUntil       — pulls a value, returns when predicate(value) is true.
//                     Predicate may throw to fast-fail (e.g. on a "failed"
//                     status); that error propagates as-is. Errors from
//                     getValue itself propagate too — this primitive does
//                     not retry through transient I/O failures.
//
//   retryUntilSettled — calls operation, returns on success. Catches
//                       errors and retries only when shouldRetry(err) is
//                       true; any other error surfaces immediately.
//
// Both throw `WaitTimeout` when the deadline passes first.

const DEFAULT_INTERVAL_MS = 5_000;

export class WaitTimeout extends Error {
  constructor(
    message: string,
    public readonly describe?: string,
    public readonly observedValue?: unknown,
  ) {
    super(message);
    this.name = "WaitTimeout";
  }
}

export interface WaitOptions {
  /** Wall-clock budget for the whole call. */
  timeoutMs: number;
  /** Sleep between attempts. Defaults to 5_000 ms. */
  intervalMs?: number;
  /** Short label included in WaitTimeout messages and onAttempt callbacks. */
  describe?: string;
  /** Invoked per attempt (incl. the first) — use it for progress logging. */
  onAttempt?: (attempt: number) => void;
}

export async function waitUntil<T>(
  getValue: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: WaitOptions,
): Promise<T> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;
  let lastValue: T | undefined;
  while (true) {
    attempt += 1;
    opts.onAttempt?.(attempt);
    const value = await getValue();
    lastValue = value;
    // predicate may throw to fast-fail; we don't catch.
    if (predicate(value)) return value;
    if (Date.now() >= deadline) {
      const label = opts.describe ?? "condition";
      throw new WaitTimeout(
        `Timed out after ${opts.timeoutMs}ms waiting for ${label}`,
        opts.describe,
        lastValue,
      );
    }
    await sleep(intervalMs);
  }
}

export async function retryUntilSettled<T>(
  operation: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  opts: WaitOptions,
): Promise<T> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = Date.now() + opts.timeoutMs;
  let attempt = 0;
  while (true) {
    attempt += 1;
    opts.onAttempt?.(attempt);
    try {
      return await operation();
    } catch (err) {
      if (!shouldRetry(err)) throw err;
      if (Date.now() >= deadline) {
        const label = opts.describe ?? "operation";
        const detail = err instanceof Error ? `: ${err.message}` : "";
        throw new WaitTimeout(
          `Timed out after ${opts.timeoutMs}ms retrying ${label}${detail}`,
          opts.describe,
        );
      }
      await sleep(intervalMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
