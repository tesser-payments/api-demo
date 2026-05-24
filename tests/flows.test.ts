// Flow tests live in one file so vitest's `sequence.shuffle.tests`
// interleaves variants across flows. The matrices below are the source of
// truth for what runs — adding/removing a row here is the only edit
// needed. Flow bodies and assertions live in `./flows/*.ts`.

import { describe } from "vitest";
import { flowTest } from "./flow-test.ts";
import { useWebhookFixture } from "./flows/webhook-fixture.ts";
import {
  meta as depositMeta,
  runDepositVariant,
  type DepositVariant,
} from "./flows/deposit-via-lp-flow.ts";
import {
  meta as payoutMeta,
  resolveWalletAddress,
  runPayoutVariant,
  type PayoutNetwork,
} from "./flows/stablecoin-payout-flow.ts";

// ----------------------------------------------------------------------
// Deposit-via-LP variants
// ----------------------------------------------------------------------
// Each row is a deposit-flow scenario. "workspace" reuses the auto-created
// workspace-level Circle Mint ledger; the others provision a fresh ledger
// with the indicated scoping (counterparty and/or tenant).

const DEPOSIT_VARIANTS: DepositVariant[] = [
  { label: "workspace",              withCounterparty: false, withTenant: false },
  { label: "counterparty",           withCounterparty: true,  withTenant: false },
  { label: "tenant",                 withCounterparty: false, withTenant: true  },
  { label: "counterparty-in-tenant", withCounterparty: true,  withTenant: true  },
];

// ----------------------------------------------------------------------
// Payout network variants
// ----------------------------------------------------------------------
// Each row is one network on the payout-to-self-custodial-wallet flow.
// `skip` annotates rows we know won't run today and why; remove the field
// to enable the row.

interface PayoutNetworkRow extends PayoutNetwork {
  skip?: string;
}

const PAYOUT_NETWORKS: PayoutNetworkRow[] = [
  // Sandbox /v1/payments rejects testnet identifiers until the platform
  // fix lands; see memory project_networks_payments_mismatch.md.
  { key: "POLYGON_AMOY", name: "Polygon Amoy", skip: "platform: /v1/payments rejects testnet keys" },
  { key: "BASE_SEPOLIA", name: "Base Sepolia", skip: "platform: /v1/payments rejects testnet keys" },
  { key: "STELLAR",      name: "Stellar"      },
];

// ----------------------------------------------------------------------

describe("flow tests", () => {
  const webhook = useWebhookFixture();

  // -- Deposit variants ------------------------------------------------

  for (const v of DEPOSIT_VARIANTS) {
    flowTest(
      {
        docUrl: depositMeta.docUrl,
        provider: "CIRCLE_MINT",
        currency: "USDC",
      },
      `(${v.label})`,
      () => runDepositVariant(v, webhook.current()),
      60 * 60 * 1000,
    );
  }

  // -- Payout variants -------------------------------------------------

  for (const n of PAYOUT_NETWORKS) {
    const variantMeta = {
      docUrl: payoutMeta.docUrl,
      provider: "CIRCLE_MINT",
      currency: "USDC",
      network: n.key,
    };
    if (n.skip) {
      flowTest.skip(variantMeta, "emits expected events", n.skip);
      continue;
    }
    if (!resolveWalletAddress(n.key)) {
      flowTest.skip(
        variantMeta,
        "emits expected events",
        `no wallet configured (set BENEFICIARY_WALLET_ADDRESS_* for ${n.key})`,
      );
      continue;
    }
    flowTest(
      variantMeta,
      "emits expected events",
      () => runPayoutVariant(n, webhook.current()),
      90 * 60 * 1000,
    );
  }
});
