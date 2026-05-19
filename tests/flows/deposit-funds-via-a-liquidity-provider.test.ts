import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";
import { run } from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import { EXPECTED_DEPOSIT_LP } from "../helpers/expected-events.ts";

describe("deposit funds via a liquidity provider (Circle Mint)", () => {
  let sub: WebhookSubscription;

  beforeEach(async () => {
    if (!process.env.WEBHOOK_SITE_TOKEN) {
      throw new Error(
        "WEBHOOK_SITE_TOKEN is required to run flow tests. Set it in .env.",
      );
    }
    await authenticate();
    sub = subscribeToWebhooks({ token: process.env.WEBHOOK_SITE_TOKEN });
    sub.startWindow();
  });

  afterEach(() => {
    sub?.stop();
  });

  test(
    "emits expected event sequence and progresses DEA overlays",
    async () => {
      const result = await run({ depositAmount: "100.00" });

      const events = await sub.scopedTo(result.depositId).collectAll({
        expectedTypes: EXPECTED_DEPOSIT_LP.types,
        timeoutMs: 180_000,
      });

      expect(events.map((e) => e.type)).toEqual([
        ...EXPECTED_DEPOSIT_LP.types,
      ]);
      expect(events.filter((e) => !e.signatureValid)).toEqual([]);
      expect(result.deposit.desired).toMatchObject(
        EXPECTED_DEPOSIT_LP.terminal.desired,
      );
      expect(result.deposit.estimated).toBeDefined();
      expect(result.deposit.actual?.to?.amount).toBeDefined();
    },
    300_000,
  );
});
