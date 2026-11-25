import { describe, expect, test } from "bun:test";
import { assertBalanceHolds, getAccount, getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { getPayment, simulateTravelRuleInbound } from "../../src/api/payments.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { Step } from "../../src/types.ts";
import { BALANCE_HOLD_MS, exactly, NETWORK, PAYMENT_TIMEOUT_MS, runWallet, usdcOf } from "../fixtures/managed-wallet.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const AUTHORIZED_TIMEOUT_MS = 13 * 60_000;
const REFUSED_TIMEOUT_MS = 7 * 60_000;
// The simulated transfer books 1 USDC on every network but Ethereum Sepolia.
const TRAVEL_RULE_AMOUNT = 1;
const AUTHORIZED = "transfers-9216";
const REFUSED_ON_NAME = "transfers-9215";
const DECISION_CODES = ["transfers-9203", AUTHORIZED, REFUSED_ON_NAME, "transfers-9218"];

const travelRuleDecision = (step: Step | undefined) =>
  step?.status_reasons?.map((r) => r.error_code).findLast((code) => DECISION_CODES.includes(code));

const answeredExchange = { is_travel_rule: true, presentation: "full", presentation_answered: true };

describe("Simulate a Travel Rule Inbound Payment", () => {
  test(
    "a Travel Rule transfer naming that wallet's owner is authorized, credited and completes",
    async () => {
      const wallet = await runWallet();
      const balance = usdcOf(wallet.id);
      const credited = exactly(parseFloat(await getAvailableBalance(balance)) + TRAVEL_RULE_AMOUNT);

      // No claimed name: the simulator claims the wallet owner's own, so the name match passes.
      const { paymentId, travelRule } = await simulateTravelRuleInbound({
        toAccountId: wallet.id,
        network: NETWORK,
        mockedRiskStatus: "automatically_approved",
      });
      expect(travelRule).toMatchObject(answeredExchange);
      const payment = await waitForPayment(paymentId, { timeoutMs: PAYMENT_TIMEOUT_MS });
      await waitForBalance({ ...balance, amount: credited });

      expect(payment.direction).toBe("inbound");
      expect(payment.risk_status).toBe("automatically_approved");
      expect(payment.steps.map((s) => s.status)).toEqual(["completed"]);
      const [transfer] = payment.steps;
      expect(travelRuleDecision(transfer)).toBe(AUTHORIZED);
      expect(transfer?.transaction_hash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(transfer?.completed_at).toBeTruthy();
      expect(payment.actual.to.account_id).toBe(wallet.id);
      expect(payment.actual.to.network).toBe(NETWORK);
      expect(payment.actual.to.currency).toBe("USDC");
      expect(parseFloat(payment.actual.to.amount ?? "0")).toBe(TRAVEL_RULE_AMOUNT);
      const notabeneTransfer = payment.provider_metadata.find((m) => m.provider_metadata_key === "NOTABENE");
      expect(notabeneTransfer?.provider_metadata_data["@id"]).toBe(travelRule.transfer_id);

      expect(payment.participants.map((p) => p.role)).toEqual(
        expect.arrayContaining(["ORIGINATOR", "ORIGINATOR_VASP", "BENEFICIARY"]),
      );
      // The run's wallet has no tenant or counterparty, so the workspace itself is paid.
      expect(payment.participants.find((p) => p.role === "BENEFICIARY")?.resource).toMatchObject({
        resource_type: "WORKSPACE",
        id: wallet.workspace_id,
      });
      const originator = payment.participants.find((p) => p.role === "ORIGINATOR");
      expect(originator?.resource.id).toBeTruthy();
      expect(payment.funding_account_id).toBeTruthy();
      const originatorAccount = await getAccount(payment.funding_account_id!);
      expect(originatorAccount.type).toBe("generic");
      expect(originatorAccount.generic_account_number).toBe("simulator-originator");
      expect(originatorAccount.counterparty_id).toBe(originator!.resource.id);
      await assertBalanceHolds({ ...balance, amount: credited, holdMs: BALANCE_HOLD_MS });
    },
    AUTHORIZED_TIMEOUT_MS,
  );

  test(
    "a Travel Rule transfer claiming another beneficiary name is refused and sends nothing",
    async () => {
      const wallet = await runWallet();
      const balance = usdcOf(wallet.id);
      const unchanged = exactly(parseFloat(await getAvailableBalance(balance)));

      const { paymentId, travelRule } = await simulateTravelRuleInbound({
        toAccountId: wallet.id,
        network: NETWORK,
        claimedBeneficiaryName: "Someone Else Entirely",
      });
      expect(travelRule).toMatchObject(answeredExchange);
      // Long enough for an authorized transfer's USDC to have arrived.
      await assertBalanceHolds({ ...balance, amount: unchanged, holdMs: BALANCE_HOLD_MS });
      const payment = await getPayment(paymentId);

      expect(payment.direction).toBe("inbound");
      expect(payment.risk_status).toBe("unchecked");
      expect(payment.steps.map((s) => s.status)).toEqual(["created"]);
      const [transfer] = payment.steps;
      expect(travelRuleDecision(transfer)).toBe(REFUSED_ON_NAME);
      expect(transfer?.transaction_hash ?? null).toBeNull();
    },
    REFUSED_TIMEOUT_MS,
  );
});
