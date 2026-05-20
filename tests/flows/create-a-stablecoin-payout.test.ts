import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WEBHOOK_SANDBOX_PUBLIC_KEY } from "@tesser-payments/types";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";
import { run as deposit } from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import { run as payout } from "../../examples/create-a-stablecoin-payout.ts";
import { EXPECTED_STABLECOIN_PAYOUT } from "../helpers/expected-events.ts";

describe("create a stablecoin payout (USDC → Stellar wallet)", () => {
  let sub: WebhookSubscription;

  beforeEach(async () => {
    if (!process.env.WEBHOOK_SITE_TOKEN) {
      throw new Error(
        "WEBHOOK_SITE_TOKEN is required to run flow tests. Set it in .env.",
      );
    }
    if (!process.env.BENEFICIARY_WALLET_ADDRESS) {
      throw new Error(
        "BENEFICIARY_WALLET_ADDRESS is required (Stellar wallet with USDC trustline). Set it in .env.",
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
  });

  test(
    "emits expected event sequence and progresses DEA overlays",
    async () => {
      // Fund a fresh ledger via the deposit flow. Webhooks for the deposit
      // arrive in `sub` but are out of scope for the payout test's assertions
      // because we'll scope to paymentId, not depositId.
      const funded = await deposit({ depositAmount: "100.00" });

      const result = await payout({
        ledgerAccountId: funded.ledgerAccountId,
        amount: "0.01",
      });

      const events = await sub.scopedTo(result.paymentId).collectAll({
        expectedTypes: EXPECTED_STABLECOIN_PAYOUT.types,
        timeoutMs: 10 * 60 * 1000,
      });

      expect(events.map((e) => e.type)).toEqual([
        ...EXPECTED_STABLECOIN_PAYOUT.types,
      ]);
      expect(events.filter((e) => !e.signatureValid)).toEqual([]);
      expect(result.payment.desired).toMatchObject(
        EXPECTED_STABLECOIN_PAYOUT.terminal.desired,
      );
      expect(result.payment.estimated).toBeDefined();
      expect(result.payment.actual?.to?.amount).toBeDefined();
    },
    // 90 min: deposit can take up to 25 min, payout up to 25 min, plus
    // webhook collection up to 10 min for the payout. Buffer for slow sandbox.
    90 * 60 * 1000,
  );
});
