import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { WEBHOOK_SANDBOX_PUBLIC_KEY } from "@tesser-payments/types";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";
import { run as deposit } from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import {
  resolveWalletAddress,
  run as payout,
} from "../../examples/create-a-stablecoin-payout.ts";
import { EXPECTED_STABLECOIN_PAYOUT } from "../helpers/expected-events.ts";
import { sharedState } from "../shared-state.ts";
import {
  NETWORKS_FILE_PATH,
  type NetworkInfo,
} from "../setup/seed-and-summary.ts";

// Resolve the supported networks at module load. globalSetup writes this
// file before the test files load. Fallback to STELLAR if missing.
function loadNetworks(): NetworkInfo[] {
  if (!existsSync(NETWORKS_FILE_PATH)) {
    return [{ key: "STELLAR" }];
  }
  try {
    return JSON.parse(readFileSync(NETWORKS_FILE_PATH, "utf8")) as NetworkInfo[];
  } catch {
    return [{ key: "STELLAR" }];
  }
}

const networks = loadNetworks();

// Networks /v1/payments accepts. The /v1/networks endpoint can return values
// (e.g. BASE) that the payments endpoint rejects with `payments-1001`. Update
// when the platform reconciles the two lists.
// See ~/.claude/projects/.../memory/project_networks_payments_mismatch.md
const PAYMENTS_SUPPORTED_NETWORKS = new Set([
  "POLYGON",
  "STELLAR",
  "ETHEREUM",
  "SOLANA",
]);

describe("create a stablecoin payout", () => {
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

  const networksPlatformSupports = networks.filter((n) =>
    PAYMENTS_SUPPORTED_NETWORKS.has(n.key),
  );
  const networksWithAddress = networksPlatformSupports.filter(
    (n) => !!resolveWalletAddress(n.key),
  );

  const skippedNotSupported = networks
    .filter((n) => !PAYMENTS_SUPPORTED_NETWORKS.has(n.key))
    .map((n) => n.key);
  const skippedNoAddress = networksPlatformSupports
    .filter((n) => !resolveWalletAddress(n.key))
    .map((n) => n.key);
  if (skippedNotSupported.length > 0) {
    console.log(
      `[payout] skipping networks /v1/payments doesn't accept: ${skippedNotSupported.join(", ")} ` +
        `(returned by /v1/networks but rejected with payments-1001)`,
    );
  }
  if (skippedNoAddress.length > 0) {
    console.log(
      `[payout] skipping networks without configured wallet: ${skippedNoAddress.join(", ")} ` +
        `(set BENEFICIARY_WALLET_ADDRESS_EVM / _STELLAR in .env to enable)`,
    );
  }

  test.each(networksWithAddress)(
    "emits expected event sequence on '$key'",
    async (network) => {
      // Reuse a funded ledger if one exists, else fund a fresh one and
      // register it for downstream reuse by the deposit-via-LP test.
      const existing = sharedState.findFundedLedger({
        provider: "CIRCLE_MINT",
        currency: "USDC",
      });
      let ledgerAccountId: string;
      if (existing) {
        sharedState.markReused(
          `payout / Circle / ${network.key}`,
          "ledger",
          existing.id,
          `originally from ${existing.createdBy}`,
        );
        ledgerAccountId = existing.id;
      } else {
        const funded = await deposit({ depositAmount: "100.00" });
        sharedState.registerLedger(
          {
            id: funded.ledgerAccountId,
            provider: "CIRCLE_MINT",
            currency: "USDC",
            hasBalance: true,
            createdBy: `payout / Circle / ${network.key} (inline fund)`,
          },
          `deposit ${funded.depositId}`,
        );
        ledgerAccountId = funded.ledgerAccountId;
      }

      const result = await payout({
        ledgerAccountId,
        amount: "0.01",
        network: network.key,
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
    90 * 60 * 1000,
  );
});
