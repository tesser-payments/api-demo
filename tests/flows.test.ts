// Single file for all flow tests so vitest's `sequence.shuffle.tests`
// interleaves variants across flows (not just within a flow). Vitest 4
// shuffles tests within a file; tests in different files only get
// file-level shuffle. Keeping everything in one describe is the only way
// to truly mix deposit variants and payout variants.

import { afterEach, beforeEach, describe, expect } from "vitest";
import { WEBHOOK_SANDBOX_PUBLIC_KEY } from "@tesser-payments/types";
import { authenticate } from "../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../src/webhooks.ts";
import {
  run as deposit,
  meta as depositMeta,
} from "../examples/deposit-funds-via-a-liquidity-provider.ts";
import {
  resolveWalletAddress,
  run as payout,
  meta as payoutMeta,
} from "../examples/create-a-stablecoin-payout.ts";
import { run as createTenant } from "../examples/create-a-tenant.ts";
import {
  EXPECTED_DEPOSIT_LP,
  EXPECTED_STABLECOIN_PAYOUT,
} from "./helpers/expected-events.ts";
import { sharedState } from "./shared-state.ts";
import { flowTest } from "./flow-test.ts";

// ----------------------------------------------------------------------
// Deposit-via-LP variants
// ----------------------------------------------------------------------

const DEPOSIT_VARIANTS: Array<{
  label: string;
  withCounterparty: boolean;
  withTenant: boolean;
}> = [
  // Workspace: the platform rejects POSTing a new workspace ledger
  // (accounts-3006), but auto-creates one when a Circle Mint API key is
  // first registered. The example discovers that pre-existing ledger and
  // deposits into it; no creation in this run.
  { label: "workspace", withCounterparty: false, withTenant: false },
  { label: "counterparty", withCounterparty: true, withTenant: false },
  { label: "tenant", withCounterparty: false, withTenant: true },
  { label: "counterparty-in-tenant", withCounterparty: true, withTenant: true },
];

// ----------------------------------------------------------------------
// Payout network variants
// ----------------------------------------------------------------------

const SANDBOX_NETWORKS: { key: string; name: string }[] = [
  { key: "POLYGON_AMOY", name: "Polygon Amoy" },
  { key: "BASE_SEPOLIA", name: "Base Sepolia" },
  { key: "STELLAR", name: "Stellar" },
];

// /v1/payments still rejects testnet identifiers until the platform fix
// lands; see memory project_networks_payments_mismatch.md.
const PAYMENTS_ACCEPTS_TODAY = new Set(["STELLAR"]);

// ----------------------------------------------------------------------

describe("flow tests", () => {
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

  // -- Deposit variants ------------------------------------------------

  for (const v of DEPOSIT_VARIANTS) {
    flowTest(
      {
        docUrl: depositMeta.docUrl,
        provider: "CIRCLE_MINT",
        currency: "USDC",
      },
      `emits expected events (${v.label})`,
      async () => {
        let tenantId: string | undefined;
        if (v.withTenant) {
          const tenant = await createTenant({});
          tenantId = tenant.tenantId;
        }
        const result = await deposit({
          depositAmount: "100.00",
          withCounterparty: v.withCounterparty,
          tenantId,
        });
        if (v.label === "workspace") {
          // Workspace ledger pre-existed (auto-created when the Circle
          // Mint key was first registered). Record as REUSED with that
          // origin instead of CREATED.
          sharedState.markReused(
            `deposit-via-LP / ${v.label}`,
            "ledger",
            result.ledgerAccountId,
            "auto-created when Circle Mint key was registered",
            {
              provider: "CIRCLE_MINT",
              currency: "USDC",
              operationKind: "deposit",
              operationId: result.depositId,
              operationSummary: "100 USD → USDC",
            },
          );
        } else {
          sharedState.registerLedger(
            {
              id: result.ledgerAccountId,
              provider: "CIRCLE_MINT",
              currency: "USDC",
              hasBalance: true,
              tenantId,
              counterpartyId: result.counterpartyId ?? undefined,
              createdBy: `deposit-via-LP / ${v.label}`,
            },
            `deposit ${result.depositId}`,
            {
              operationKind: "deposit",
              operationId: result.depositId,
              operationSummary: "100 USD → USDC",
            },
          );
        }
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
  }

  // -- Payout variants -------------------------------------------------

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
        const existing = sharedState.findFundedLedger({
          provider: "CIRCLE_MINT",
          currency: "USDC",
        });
        let ledgerAccountId: string;
        if (existing) {
          ledgerAccountId = existing.id;
        } else {
          const funded = await deposit({ depositAmount: "100.00" });
          sharedState.registerLedger(
            {
              id: funded.ledgerAccountId,
              provider: "CIRCLE_MINT",
              currency: "USDC",
              hasBalance: true,
              counterpartyId: funded.counterpartyId ?? undefined,
              createdBy: `payout / Circle / ${network.key} (inline fund)`,
            },
            `deposit ${funded.depositId}`,
            {
              operationKind: "deposit",
              operationId: funded.depositId,
              operationSummary: "100 USD → USDC",
            },
          );
          ledgerAccountId = funded.ledgerAccountId;
        }

        const result = await payout({
          ledgerAccountId,
          amount: "0.01",
          network: network.key,
        });

        if (existing) {
          sharedState.markReused(
            `payout / Circle / ${network.key}`,
            "ledger",
            existing.id,
            undefined,
            {
              provider: "CIRCLE_MINT",
              currency: "USDC",
              network: network.key,
              operationKind: "payment",
              operationId: result.paymentId,
              operationSummary: `0.01 USDC → ${network.key} wallet`,
            },
          );
        }

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
