import { get, getAll, post, postSignature } from "../client.ts";
import { poll, postWithRetry } from "../retry.ts";
import type {
  Envelope,
  MockedRiskStatus,
  Payment,
  SimulatedInboundPending,
  SimulatedTravelRuleInbound,
  SimulatedTravelRuleInboundPending,
  TravelRuleExchange,
} from "../types.ts";

/** Networks `POST /v1/payments/simulate-inbound` sends on. */
export type InboundNetwork = "POLYGON_AMOY" | "BASE_SEPOLIA" | "ETHEREUM_SEPOLIA" | "TEMPO_MODERATO";

/** Networks `POST /v1/payments/simulate-travel-rule-inbound` sends on. */
export type TravelRuleNetwork = "POLYGON_AMOY" | "BASE_SEPOLIA" | "ETHEREUM_SEPOLIA";

export async function getPayment(paymentId: string): Promise<Payment> {
  const { data } = await get<Envelope<Payment>>(`/v1/payments/${paymentId}`);
  return data;
}

/**
 * A same-currency payout from one account to another. `fundingAccountId` is the
 * Travel Rule originator's account (a counterparty's or tenant's), or the source itself.
 */
export async function createPayment({
  fundingAccountId,
  fromAccountId,
  toAccountId,
  amount,
  currency,
  network,
  reference,
}: {
  fundingAccountId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: string;
  currency: string;
  network: string;
  reference: string;
}): Promise<string> {
  const payment = await postWithRetry<Envelope<Payment>>(
    "Payment",
    "/v1/payments",
    {
      organization_reference_id: reference,
      funding_account_id: fundingAccountId,
      desired: {
        from: { account_id: fromAccountId, amount, currency, network },
        to: { account_id: toAccountId, currency, network },
      },
    },
    // payments-3017: the beneficiary's Circle recipient isn't active yet
    { retryOn: ["payments-3017"], attempts: 30 },
  );
  return payment.data.id;
}

/**
 * Submit the signature for a wallet step. Not retried here, so a retry by the
 * caller resends the same signature under the same key.
 */
export async function submitStepSignature({
  paymentId,
  stepId,
  signature,
  idempotencyKey,
}: {
  paymentId: string;
  stepId: string;
  signature: string;
  idempotencyKey: string;
}): Promise<void> {
  await postSignature(`/v1/payments/${paymentId}/steps/${stepId}/sign`, { signature }, { idempotencyKey });
}

/**
 * Sandbox only: Tesser sends 1 test USDC to the managed wallet `toAccountId`, with
 * the sender's screening verdict forced to `mockedRiskStatus`. Returns the payment id.
 */
export async function simulateInbound({
  toAccountId,
  mockedRiskStatus,
  network,
}: {
  toAccountId: string;
  mockedRiskStatus: MockedRiskStatus;
  network: InboundNetwork;
}): Promise<string> {
  // Allows for clock skew between this machine and the platform.
  const searchFrom = new Date(Date.now() - 5 * 60_000).toISOString();
  // Never retried: the platform can answer 5xx after it has sent the USDC.
  const { data } = await post<Envelope<Payment | SimulatedInboundPending>>(
    "/v1/payments/simulate-inbound",
    { to_account: toAccountId, mocked_risk_status: mockedRiskStatus, network },
    { idempotencyKey: crypto.randomUUID() },
  );
  if (!("tx_hash" in data)) return data.id;
  if (data.payment_id) return data.payment_id;
  return waitForInboundPayment({ txHash: data.tx_hash, searchFrom });
}

/**
 * Sandbox only: a simulator VASP sends a Notabene Travel Rule transfer to the managed
 * wallet `toAccountId`, claiming `claimedBeneficiaryName` as the beneficiary (by default
 * the wallet owner's own name). Resolves once the organization's decision landed; where
 * it authorized the transfer, the USDC follows the response.
 */
export async function simulateTravelRuleInbound({
  toAccountId,
  network,
  claimedBeneficiaryName,
  mockedRiskStatus,
}: {
  toAccountId: string;
  network: TravelRuleNetwork;
  claimedBeneficiaryName?: string;
  mockedRiskStatus?: MockedRiskStatus;
}): Promise<{ paymentId: string; travelRule: TravelRuleExchange }> {
  // Allows for clock skew between this machine and the platform.
  const searchFrom = new Date(Date.now() - 5 * 60_000).toISOString();
  // Never retried: each call creates a new Notabene transfer, and an authorized one sends USDC.
  const { data } = await post<Envelope<SimulatedTravelRuleInbound | SimulatedTravelRuleInboundPending>>(
    "/v1/payments/simulate-travel-rule-inbound",
    {
      to_account: toAccountId,
      network,
      claimed_beneficiary_name: claimedBeneficiaryName,
      mocked_risk_status: mockedRiskStatus,
    },
    { idempotencyKey: crypto.randomUUID() },
  );
  const travelRule = data.travel_rule;
  if ("id" in data) return { paymentId: data.id, travelRule };
  if (!travelRule.is_travel_rule || !travelRule.presentation_answered) {
    throw new Error(
      `Notabene transfer ${travelRule.transfer_id} ended with is_travel_rule=${travelRule.is_travel_rule} and presentation_answered=${travelRule.presentation_answered}, so no decision will follow`,
    );
  }
  return { paymentId: await waitForTravelRulePayment({ transferId: travelRule.transfer_id, searchFrom }), travelRule };
}

async function waitForTravelRulePayment({ transferId, searchFrom }: { transferId: string; searchFrom: string }): Promise<string> {
  return poll(
    "Travel Rule decision",
    async () => {
      const payments = await getAll<Payment>(`/v1/payments?direction=inbound&start_date=${encodeURIComponent(searchFrom)}`);
      return payments.find((p) =>
        p.provider_metadata.some((m) => m.provider_metadata_key === "NOTABENE" && m.provider_metadata_data["@id"] === transferId),
      )?.id;
    },
    {
      timeoutMs: 5 * 60_000,
      timeoutHint: `no inbound payment carries Notabene transfer ${transferId}; the organization's Travel Rule decision hasn't landed`,
    },
  );
}

async function waitForInboundPayment({ txHash, searchFrom }: { txHash: string; searchFrom: string }): Promise<string> {
  const hash = txHash.toLowerCase();
  return poll(
    "Inbound detection",
    async () => {
      const payments = await getAll<Payment>(`/v1/payments?direction=inbound&start_date=${encodeURIComponent(searchFrom)}`);
      return payments.find((p) => p.steps.some((s) => s.transaction_hash?.toLowerCase() === hash))?.id;
    },
    {
      timeoutMs: 5 * 60_000,
      timeoutHint: `no inbound payment has transaction ${txHash}; the platform may not be watching the wallet on this network yet`,
    },
  );
}
