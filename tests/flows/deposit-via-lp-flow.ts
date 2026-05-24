// Deposit-via-LP flow: runs the example and asserts terminal state +
// webhook event sequence. One exported entry point per test case so the
// matrix in `tests/flows.test.ts` stays a thin loop over variants.

import { expect } from "vitest";
import { type WebhookSubscription } from "../../src/webhooks.ts";
import {
  run as deposit,
  meta as depositMeta,
  type DepositLpResult,
} from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import { run as createTenant } from "../../examples/create-a-tenant.ts";
import { EXPECTED_DEPOSIT_LP } from "../helpers/expected-events.ts";
import { sharedState } from "../shared-state.ts";
import { countByType } from "./webhook-fixture.ts";

export { depositMeta as meta };

export interface DepositVariant {
  /** Short label that becomes the test name suffix. */
  label: string;
  withCounterparty: boolean;
  withTenant: boolean;
}

export async function runDepositVariant(
  v: DepositVariant,
  sub: WebhookSubscription,
): Promise<void> {
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
  recordSharedState(v, result, tenantId);

  const events = await sub.scopedTo(result.depositId).collectAll({
    expectedTypes: EXPECTED_DEPOSIT_LP.types,
    timeoutMs: 10 * 60 * 1000,
  });

  expect(countByType(events.map((e) => e.type))).toEqual(
    countByType(EXPECTED_DEPOSIT_LP.types),
  );
  expect(events.filter((e) => !e.signatureValid)).toEqual([]);
  assertDepositTerminal(result);
}

function recordSharedState(
  v: DepositVariant,
  result: DepositLpResult,
  tenantId: string | undefined,
): void {
  if (v.label === "workspace") {
    // Workspace ledger pre-existed (auto-created when the Circle Mint key
    // was first registered). Record as REUSED with that origin instead of
    // CREATED.
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
    return;
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
}

// Deposit terminal contract (verified empirically against sandbox; see
// comments in EXPECTED_DEPOSIT_LP for doc-vs-reality notes).
function assertDepositTerminal(result: DepositLpResult): void {
  expect(result.deposit.desired).toMatchObject(EXPECTED_DEPOSIT_LP.terminal.desired);
  expect(result.deposit.estimated).toBeDefined();
  expect(result.deposit.actual?.to?.amount).toBeDefined();
  expect(result.deposit.direction).toBe("inbound");
  expect(result.deposit.expires_at).toEqual(expect.any(String));

  // The Circle Mint same-currency path always uses two steps: a USD
  // transfer (bank → Circle intermediate) and a USD→USDC swap.
  expect(result.deposit.steps).toHaveLength(2);
  const transferStep = result.deposit.steps?.find((s) => s.step_type === "transfer");
  const swapStep = result.deposit.steps?.find((s) => s.step_type === "swap");
  expect(transferStep).toBeDefined();
  expect(swapStep).toBeDefined();
  for (const step of result.deposit.steps ?? []) {
    expect(step.status).toBe("completed");
    expect(step.provider_key).toBe("circle_mint");
    // Circle Mint deposit steps are off-chain — no transaction hash.
    expect(step.transaction_hash).toBeNull();
    expect(step.completed_at).toEqual(expect.any(String));
    expect(step.status_reasons ?? []).toEqual([]);
  }

  // DEA overlay shape: desired.to.amount stays null (Circle picks the
  // rate); estimated and actual both fully populate; values are 1:1
  // USD → USDC at Circle Mint sandbox.
  expect(result.deposit.desired?.to?.amount).toBeNull();
  expect(result.deposit.estimated?.from?.amount).toBe(result.deposit.desired?.from?.amount);
  expect(result.deposit.actual?.from?.amount).toBe(result.deposit.estimated?.from?.amount);
  expect(result.deposit.actual?.to?.amount).toBe(result.deposit.estimated?.to?.amount);
}
