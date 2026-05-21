import { afterEach, beforeEach, describe, expect } from "vitest";
import { WEBHOOK_SANDBOX_PUBLIC_KEY } from "@tesser-payments/types";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";
import { run as deposit, meta as depositMeta } from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import { run as createTenant } from "../../examples/create-a-tenant.ts";
import { EXPECTED_DEPOSIT_LP } from "../helpers/expected-events.ts";
import { sharedState } from "../shared-state.ts";
import { flowTest } from "../flow-test.ts";

// The platform requires a Circle Mint ledger to carry exactly one of
// tenant_id or counterparty_id (workspace-only and both-at-once are both
// rejected; see memory project_ledger_ownership_constraints.md). When a
// counterparty is tenant-scoped, the ledger inherits tenant scope through
// it — the ledger payload only ever names the counterparty.
//
// Three valid variants:
//   - counterparty            : ledger ← counterparty (no tenant anywhere)
//   - tenant                  : ledger ← tenant (no counterparty)
//   - counterparty-in-tenant  : ledger ← counterparty ← tenant (counterparty
//                               itself is tenant-scoped, ledger only carries
//                               counterparty_id)
const VARIANTS: Array<{
  label: string;
  withCounterparty: boolean;
  withTenant: boolean;
}> = [
  { label: "counterparty", withCounterparty: true, withTenant: false },
  { label: "tenant", withCounterparty: false, withTenant: true },
  { label: "counterparty-in-tenant", withCounterparty: true, withTenant: true },
];

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

  for (const v of VARIANTS) {
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
  }
});
