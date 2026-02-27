import pc from "picocolors";
import pRetry, { AbortError } from "p-retry";
import type { Options } from "p-retry";

export const RETRY_INTERVAL_MS = 10_000;
export const RETRY_MAX_ATTEMPTS = 60;

export { pRetry, AbortError };

export const retryOpts = (label: string): Options => ({
  retries: RETRY_MAX_ATTEMPTS - 1,
  minTimeout: RETRY_INTERVAL_MS,
  maxTimeout: RETRY_INTERVAL_MS,
  factor: 1,
  onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
    console.log(
      pc.yellow(
        `  ${label} attempt ${attemptNumber}/${RETRY_MAX_ATTEMPTS} failed: ${error.message}`,
      ),
    );
    if (retriesLeft > 0) {
      console.log(pc.dim(`  Retrying in ${RETRY_INTERVAL_MS / 1000}s...`));
    }
  },
});
