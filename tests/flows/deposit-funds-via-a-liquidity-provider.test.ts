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

// Four account-ownership scenarios for the deposit destination ledger.
// Circle Mint currently rejects the "workspace" combination at the API
// (accounts-3006: ledgers need exactly one of tenant/counterparty). We
// keep the variant in the matrix so its absence is visible; the test
// detects the platform reject and marks itself as skipped rather than
// failing. See memory project_ledger_ownership_constraints.md.
const VARIANTS: Array<{
  label: string;
  withCounterparty: boolean;
  withTenant: boolean;
  /** Platform-reject code that, if observed, marks this variant as skip. */
  platformRejectCode?: string;
}> = [
  {
    label: "workspace",
    withCounterparty: false,
    withTenant: false,
    platformRejectCode: "accounts-3006",
  },
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
      async (ctx) => {
        let tenantId: string | undefined;
        if (v.withTenant) {
          const tenant = await createTenant({});
          tenantId = tenant.tenantId;
        }
        let result;
        try {
          result = await deposit({
            depositAmount: "100.00",
            withCounterparty: v.withCounterparty,
            tenantId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            v.platformRejectCode &&
            msg.includes(v.platformRejectCode)
          ) {
            ctx.skip(
              `platform rejects (${v.platformRejectCode}): ` +
                `Circle Mint requires either tenant or counterparty`,
            );
          }
          throw err;
        }
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
