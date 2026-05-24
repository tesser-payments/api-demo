// Webhook subscription fixture for flow tests. Exposes `useWebhookFixture()`
// which registers the beforeEach/afterEach hooks against the enclosing
// describe block and returns a `subOf(ctx)` accessor. Tests call the
// accessor to get the live WebhookSubscription for the current test.

import { afterEach, beforeEach } from "vitest";
import { WEBHOOK_SANDBOX_PUBLIC_KEY } from "@tesser-payments/types";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";

export interface WebhookFixture {
  /** Returns the live subscription for the test currently running. */
  current(): WebhookSubscription;
}

export function useWebhookFixture(): WebhookFixture {
  let sub: WebhookSubscription | undefined;

  beforeEach(async () => {
    if (!process.env.WEBHOOK_SITE_TOKEN) {
      throw new Error(
        "WEBHOOK_SITE_TOKEN is required to run flow tests. Set it in .env.",
      );
    }
    await authenticate();
    sub = subscribeToWebhooks({
      token: process.env.WEBHOOK_SITE_TOKEN,
      apiKey: process.env.WEBHOOK_SITE_API_KEY,
      publicKey: WEBHOOK_SANDBOX_PUBLIC_KEY,
    });
    sub.startWindow();
  });

  afterEach(() => {
    sub?.stop();
    sub = undefined;
  });

  return {
    current() {
      if (!sub) {
        throw new Error(
          "useWebhookFixture: subscription not initialized (call from inside a test, not at module load).",
        );
      }
      return sub;
    },
  };
}

export function countByType(types: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of types) out[t] = (out[t] ?? 0) + 1;
  return out;
}
