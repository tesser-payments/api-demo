import pc from "picocolors";
import pRetry, { AbortError } from "p-retry";
import type { Options } from "p-retry";
import { ApiError, NetworkError, post } from "./client.ts";

export const RETRY_INTERVAL_MS = 10_000;
export const RETRY_MAX_ATTEMPTS = 60;

export { pRetry, AbortError };

// "Same Idempotency-Key is still being processed": safe to retry with that key.
const ALWAYS_TRANSIENT_CODES = ["idempotency-0001"];

/**
 * Whether a failed request can succeed if repeated: a network failure, a 5xx
 * or 429, or an API error whose code the caller listed as "not ready yet".
 */
export function isTransient(
  error: unknown,
  retryOn: readonly string[] = [],
): boolean {
  if (error instanceof NetworkError) return true;
  if (!(error instanceof ApiError)) return false;
  return (
    error.status >= 500 ||
    error.status === 429 ||
    error.hasCode(...ALWAYS_TRANSIENT_CODES, ...retryOn)
  );
}

export interface RetryPolicy {
  /** API error codes that mean "not ready yet" for this call, e.g. `treasury-3103`. */
  retryOn?: readonly string[];
  attempts?: number;
  intervalMs?: number;
}

// API errors stop at once unless transient. Errors the caller throws itself
// (a pRetry poll's "not ready yet") keep retrying; p-retry never retries TypeErrors.
const shouldRetry = (error: unknown, retryOn: readonly string[]) =>
  error instanceof ApiError
    ? isTransient(error, retryOn)
    : !(error instanceof TypeError);

export const retryOpts = (
  label: string,
  {
    retryOn = [],
    attempts = RETRY_MAX_ATTEMPTS,
    intervalMs = RETRY_INTERVAL_MS,
  }: RetryPolicy = {},
): Options => ({
  retries: attempts - 1,
  minTimeout: intervalMs,
  maxTimeout: intervalMs,
  factor: 1,
  shouldRetry: ({ error }) => shouldRetry(error, retryOn),
  onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
    console.log(
      pc.yellow(
        `  ${label} attempt ${attemptNumber}/${attempts} failed: ${error.message}`,
      ),
    );
    if (!shouldRetry(error, retryOn)) {
      console.log(pc.red("  Not retryable, giving up"));
    } else if (retriesLeft > 0) {
      console.log(pc.dim(`  Retrying in ${intervalMs / 1000}s...`));
    }
  },
});

/**
 * POST with an Idempotency-Key, retried per `retryOpts`. The key is kept across
 * transient failures, so a request that already landed is not executed twice.
 * It is renewed after a `retryOn` error: the API caches 4xx responses per key
 * and would replay that error to every retry.
 */
export async function postWithRetry<T>(
  label: string,
  path: string,
  body: unknown,
  policy: RetryPolicy = {},
): Promise<T> {
  const retryOn = policy.retryOn ?? [];
  let idempotencyKey = crypto.randomUUID();
  return pRetry(async () => {
    try {
      return await post<T>(path, body, { idempotencyKey });
    } catch (error) {
      if (error instanceof ApiError && error.hasCode(...retryOn)) {
        idempotencyKey = crypto.randomUUID();
      }
      throw error;
    }
  }, retryOpts(label, policy));
}

export interface PollOptions {
  timeoutMs: number;
  intervalMs?: number;
  /** Appended to the timeout error, e.g. the likely cause. */
  timeoutHint?: string;
}

/**
 * Call `check` until it returns a value other than `undefined`, and return it.
 * Throw from `check` to stop early (e.g. a step failed). Transient errors are
 * retried until the deadline.
 */
export async function poll<T>(
  label: string,
  check: () => Promise<T | undefined>,
  { timeoutMs, intervalMs = RETRY_INTERVAL_MS, timeoutHint }: PollOptions,
): Promise<T> {
  const start = Date.now();
  while (true) {
    try {
      const result = await check();
      if (result !== undefined) return result;
    } catch (error) {
      if (!isTransient(error)) throw error;
      console.log(pc.yellow(`  ${label}: ${(error as Error).message}`));
    }

    const elapsed = Date.now() - start;
    if (elapsed + intervalMs > timeoutMs) {
      throw new Error(
        `${label} timed out after ${Math.round(elapsed / 1000)}s` +
          (timeoutHint ? `. ${timeoutHint}` : ""),
      );
    }
    await Bun.sleep(intervalMs);
  }
}
