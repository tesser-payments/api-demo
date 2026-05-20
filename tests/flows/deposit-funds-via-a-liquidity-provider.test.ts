import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WEBHOOK_SANDBOX_PUBLIC_KEY } from "@tesser-payments/types";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";
import { run } from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import { run as createTenant } from "../../examples/create-a-tenant.ts";
import { EXPECTED_DEPOSIT_LP } from "../helpers/expected-events.ts";
import { sharedState } from "../shared-state.ts";

describe("deposit funds via a liquidity provider (Circle Mint)", () => {
  let sub: WebhookSubscription;

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
  });

  test(
    "emits expected event sequence and progresses DEA overlays",
    async () => {
      const result = await run({ depositAmount: "100.00" });

      sharedState.registerLedger(
        {
          id: result.ledgerAccountId,
          provider: "CIRCLE_MINT",
          currency: "USDC",
          hasBalance: true,
          createdBy: "deposit-via-LP / org-level",
        },
        `deposit ${result.depositId}`,
      );

      const events = await sub.scopedTo(result.depositId).collectAll({
        expectedTypes: EXPECTED_DEPOSIT_LP.types,
        // Webhook delivery may lag the deposit's terminal state by minutes.
        timeoutMs: 10 * 60 * 1000,
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
    // 60 min: example.run() can take up to 25 min (sandbox sim duration) +
    // collectAll up to 10 min for webhook delivery lag + buffer for slow runs.
    60 * 60 * 1000,
  );

  test(
    "deposit succeeds under a tenant",
    async () => {
      const tenant = await createTenant({});

      const result = await run({
        depositAmount: "100.00",
        tenantId: tenant.tenantId,
      });

      sharedState.registerLedger(
        {
          id: result.ledgerAccountId,
          provider: "CIRCLE_MINT",
          currency: "USDC",
          hasBalance: true,
          tenantId: tenant.tenantId,
          createdBy: "deposit-via-LP / tenant",
        },
        `deposit ${result.depositId} under tenant ${tenant.tenantId.slice(0, 8)}`,
      );

      const events = await sub.scopedTo(result.depositId).collectAll({
        expectedTypes: EXPECTED_DEPOSIT_LP.types,
        timeoutMs: 10 * 60 * 1000,
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
    60 * 60 * 1000,
  );
});
