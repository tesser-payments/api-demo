import { afterEach, beforeEach, describe, expect } from "vitest";
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
  meta as payoutMeta,
} from "../../examples/create-a-stablecoin-payout.ts";
import { EXPECTED_STABLECOIN_PAYOUT } from "../helpers/expected-events.ts";
import { sharedState } from "../shared-state.ts";
import { flowTest } from "../flow-test.ts";

// The /v1/networks endpoint is currently inaccurate (returns mainnet keys
// like POLYGON when the sandbox is actually on Polygon Amoy testnet). Until
// the endpoint is fixed, hardcode the testnet identifiers the sandbox
// accepts. When /v1/networks reflects reality, switch back to fetching at
// globalSetup time (see project_networks_payments_mismatch.md memory).
const SANDBOX_NETWORKS: { key: string; name: string }[] = [
  { key: "POLYGON_AMOY", name: "Polygon Amoy" },
  { key: "BASE_SEPOLIA", name: "Base Sepolia" },
  { key: "STELLAR", name: "Stellar" },
];

// Networks /v1/payments actually accepts today. The platform is moving to
// testnet identifiers; until /v1/payments catches up to /v1/networks's new
// shape, only the values listed here pass the payment-creation validator.
// When platform updates, expand this set to include POLYGON_AMOY,
// BASE_SEPOLIA, and remove this comment.
const PAYMENTS_ACCEPTS_TODAY = new Set(["STELLAR"]);

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

  const acceptedNetworks = SANDBOX_NETWORKS.filter((n) =>
    PAYMENTS_ACCEPTS_TODAY.has(n.key),
  );
  const networksWithAddress = acceptedNetworks.filter(
    (n) => !!resolveWalletAddress(n.key),
  );

  const skippedPlatformPending = SANDBOX_NETWORKS
    .filter((n) => !PAYMENTS_ACCEPTS_TODAY.has(n.key))
    .map((n) => n.key);
  const skippedNoAddress = acceptedNetworks
    .filter((n) => !resolveWalletAddress(n.key))
    .map((n) => n.key);
  if (skippedPlatformPending.length > 0) {
    console.log(
      `[payout] skipping networks awaiting platform fix: ${skippedPlatformPending.join(", ")} ` +
        `(sandbox /v1/payments still rejects testnet identifiers; update PAYMENTS_ACCEPTS_TODAY when fixed)`,
    );
  }
  if (skippedNoAddress.length > 0) {
    console.log(
      `[payout] skipping networks without configured wallet: ${skippedNoAddress.join(", ")} ` +
        `(set BENEFICIARY_WALLET_ADDRESS_EVM / _STELLAR in .env to enable)`,
    );
  }

  for (const network of networksWithAddress) {
    flowTest(
      {
        docUrl: payoutMeta.docUrl,
        provider: "CIRCLE_MINT",
        currency: "USDC",
        network: network.key,
      },
      "emits expected events",
      async () => {
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
            { provider: "CIRCLE_MINT", currency: "USDC", network: network.key },
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
  }
});
