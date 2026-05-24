// Sequential tutorial runner. Each tutorial under `tutorials/` is a
// concrete walkthrough (no parameters, hardcoded values). They build on
// each other in the numeric-prefix order, threading IDs via the local
// `tutorials/.state.json` file the way a customer would.
//
// This file is the single source of truth for which tutorials exist and
// in what order. The test driver runs them sequentially in one test so
// vitest's per-test shuffle can't reorder them, and asserts on the API
// resources each tutorial creates.

import { beforeAll, describe, expect, test } from "vitest";
import { authenticate, get } from "../src/client.ts";
import { tutorial as tutorial01 } from "../tutorials/01-create-a-counterparty.ts";
import { tutorial as tutorial02 } from "../tutorials/02-create-a-ledger.ts";
import { tutorial as tutorial03 } from "../tutorials/03-deposit-via-LP.ts";
import { tutorial as tutorial04 } from "../tutorials/04-payout-stellar.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("tutorials (run in numeric order)", () => {
  beforeAll(async () => {
    await authenticate();
  });

  test(
    "01 → 02 → 03 → 04 chain takes a counterparty all the way to a Stellar payout",
    async () => {
      // ---- Tutorial 01: create counterparty ----------------------------
      const t01 = await tutorial01();
      expect(t01.counterpartyId).toMatch(UUID_RE);

      const cp = await get<{
        data: {
          id: string;
          classification: string;
          business_legal_name: string;
          business_dba: string;
          business_address_country: string;
        };
      }>(`/v1/entities/counterparties/${t01.counterpartyId}`);
      expect(cp.data.id).toBe(t01.counterpartyId);
      expect(cp.data.classification).toBe("business");
      expect(cp.data.business_legal_name).toBe(t01.name);
      expect(cp.data.business_dba).toBe(t01.name);
      expect(cp.data.business_address_country).toBe("US");

      // ---- Tutorial 02: create ledger ----------------------------------
      const t02 = await tutorial02();
      expect(t02.ledgerAccountId).toMatch(UUID_RE);

      const ledger = await get<{
        data: {
          id: string;
          type: string;
          provider: string;
          counterparty_id?: string | null;
          tenant_id?: string | null;
          metadata?: {
            circle_mint?: { circle_compliance_state?: string };
          };
        };
      }>(`/v1/accounts/${t02.ledgerAccountId}`);
      expect(ledger.data.id).toBe(t02.ledgerAccountId);
      expect(ledger.data.type).toBe("ledger");
      expect(ledger.data.provider).toBe("CIRCLE_MINT");
      expect(ledger.data.counterparty_id).toBe(t01.counterpartyId);
      expect(ledger.data.tenant_id ?? null).toBeNull();
      expect(ledger.data.metadata?.circle_mint?.circle_compliance_state).toBe(
        "ACCEPTED",
      );

      // ---- Tutorial 03: deposit USD → USDC -----------------------------
      const t03 = await tutorial03();
      expect(t03.depositId).toMatch(UUID_RE);
      expect(t03.ledgerAccountId).toBe(t02.ledgerAccountId);
      expect(t03.finalBalance).toBe("100");

      const deposit = await get<{
        data: {
          id: string;
          direction: string;
          desired?: { from?: { currency?: string }; to?: { currency?: string } };
          actual?: { to?: { amount?: string } };
          steps?: { status: string; step_type: string }[];
        };
      }>(`/v1/treasury/deposits/${t03.depositId}`);
      expect(deposit.data.id).toBe(t03.depositId);
      expect(deposit.data.direction).toBe("inbound");
      expect(deposit.data.desired?.from?.currency).toBe("USD");
      expect(deposit.data.desired?.to?.currency).toBe("USDC");
      expect(deposit.data.actual?.to?.amount).toBe("100");
      expect(deposit.data.steps).toHaveLength(2);
      for (const step of deposit.data.steps ?? []) {
        expect(step.status).toBe("completed");
      }
      // Circle Mint same-currency path is transfer + swap (one of each).
      const stepTypes = (deposit.data.steps ?? []).map((s) => s.step_type);
      expect(stepTypes).toContain("transfer");
      expect(stepTypes).toContain("swap");

      // ---- Tutorial 04: payout USDC → Stellar wallet --------------------
      const t04 = await tutorial04();
      expect(t04.paymentId).toMatch(UUID_RE);
      expect(t04.walletAccountId).toMatch(UUID_RE);
      expect(t04.beneficiaryCounterpartyId).toMatch(UUID_RE);
      expect(t04.finalAmount).toBe("0.01");
      expect(t04.transactionHash.length).toBeGreaterThan(0);

      const payment = await get<{
        data: {
          id: string;
          direction: string;
          risk_status?: string;
          balance_status?: string;
          desired?: {
            from?: { currency?: string; network?: string };
            to?: { currency?: string; network?: string };
          };
          actual?: {
            from?: { account_id?: string; amount?: string };
            to?: { amount?: string };
          };
          steps?: {
            status: string;
            step_type: string;
            provider_key?: string;
            transaction_hash?: string | null;
          }[];
        };
      }>(`/v1/payments/${t04.paymentId}`);
      expect(payment.data.id).toBe(t04.paymentId);
      expect(payment.data.direction).toBe("outbound");
      expect(payment.data.risk_status).toBe("auto_approved");
      expect(payment.data.balance_status).toBe("reserved");
      expect(payment.data.desired?.from?.currency).toBe("USDC");
      expect(payment.data.desired?.from?.network).toBe("STELLAR");
      expect(payment.data.desired?.to?.currency).toBe("USDC");
      expect(payment.data.desired?.to?.network).toBe("STELLAR");
      // Payment came from our ledger.
      expect(payment.data.actual?.from?.account_id).toBe(t02.ledgerAccountId);
      // Same-currency: amount equality across actual.
      expect(payment.data.actual?.to?.amount).toBe("0.01");
      expect(payment.data.steps).toHaveLength(1);
      const step = payment.data.steps?.[0]!;
      expect(step.status).toBe("completed");
      expect(step.step_type).toBe("transfer");
      expect(step.provider_key).toBe("circle_mint");
      expect(step.transaction_hash).toBeTruthy();
    },
    // 35 min: tutorial 03's deposit poll can run up to 25 min on slow
    // sandbox; the other steps add another ~5 min of headroom.
    35 * 60 * 1000,
  );
});
