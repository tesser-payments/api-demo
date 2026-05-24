// Tutorial 04: Send a USDC payout from the funded ledger to a Stellar wallet.
//
// Reads `ledgerAccountId` from `tutorials/.state.json` (the deposit
// destination from tutorials 02 + 03). Reads
// `BENEFICIARY_WALLET_ADDRESS_STELLAR` from env (the customer-provided
// Stellar recipient — needs an active USDC trustline).
//
// Creates a fresh individual counterparty for the recipient, an
// unmanaged Stellar wallet account tied to that counterparty, finds the
// org-level fiat bank used for fee funding, then POSTs the payment with
// retry-on-`payments-3017` while Circle finishes risk-approving the new
// wallet. Polls the payment until `actual.to.amount` populates.
//
// Standalone run (after tutorial 03, with BENEFICIARY_WALLET_ADDRESS_STELLAR set):
//   bun run tutorials/04-payout-stellar.ts
//
// Derived from `examples/create-a-stablecoin-payout.ts`. Source docs:
// https://docs.tesser.xyz/how-tos/send-a-stablecoin-payout/create-a-stablecoin-payout

import pc from "picocolors";
import { authenticate, get, getAll, post } from "../src/client.ts";
import { loadState, saveState } from "./state.ts";

export interface PayoutResult {
  paymentId: string;
  walletAccountId: string;
  beneficiaryCounterpartyId: string;
  finalAmount: string;
  transactionHash: string;
}

const PAYOUT_AMOUNT = "0.01";

export async function tutorial(): Promise<PayoutResult> {
  const state = loadState();
  if (!state.ledgerAccountId) {
    throw new Error(
      "tutorials/.state.json is missing `ledgerAccountId`. " +
        "Run tutorials 02 and 03 first.",
    );
  }
  const recipientAddress =
    process.env.BENEFICIARY_WALLET_ADDRESS_STELLAR ??
    process.env.BENEFICIARY_WALLET_ADDRESS;
  if (!recipientAddress) {
    throw new Error(
      "BENEFICIARY_WALLET_ADDRESS_STELLAR is required (a Stellar account " +
        "with an active USDC trustline). Set it in .env.",
    );
  }

  // 1. Create an individual counterparty for the recipient. (See tutorial
  //    01 for the business shape.) Timestamp suffix keeps the LEI unique
  //    so Circle's external-entity dedup doesn't reject re-runs.
  const runId = Date.now().toString();
  const beneficiaryLastName = `Recipient-${runId}`;
  const beneficiaryName = `Alice ${beneficiaryLastName}`;
  const beneficiary = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "individual",
      individual_first_name: "Alice",
      individual_last_name: beneficiaryLastName,
      individual_address_country: "US",
      individual_street_address1: "456 Oak Avenue",
      individual_city: "Boulder",
      individual_state: "CO",
      individual_postal_code: "80301",
    },
  );
  const beneficiaryId = beneficiary.data.id;

  // 2. Create an unmanaged (self-custodial) Stellar wallet for the recipient.
  const wallet = await post<{ data: { id: string } }>("/v1/accounts/wallets", {
    name: `${beneficiaryName}'s Wallet`,
    type: "stablecoin_stellar",
    is_managed: false,
    wallet_address: recipientAddress,
    counterparty_id: beneficiaryId,
  });
  const walletAccountId = wallet.data.id;

  // 3. Find the org-level fiat bank used for fee funding. The platform
  //    rejects payments without `funding_account_id` even on same-currency
  //    transfers (it covers gas).
  const fundingBankId = await findOrCreateFundingBank();

  // 4. POST the payment. The DEA `desired` overlay carries the routing
  //    intent; the platform fills `estimated`/`actual` as steps progress.
  //    Circle's risk approval on the new wallet is asynchronous, so we
  //    retry only on `payments-3017` ("to_account has not yet been risk
  //    approved by custodian"); any other error is real.
  const paymentId = await createPaymentWhenReady({
    funding_account_id: fundingBankId,
    desired: {
      from: {
        account_id: state.ledgerAccountId,
        amount: PAYOUT_AMOUNT,
        currency: "USDC",
        network: "STELLAR",
      },
      to: {
        account_id: walletAccountId,
        currency: "USDC",
        network: "STELLAR",
      },
    },
  });

  // 5. Poll until the payment's `actual.to.amount` populates.
  const terminal = await pollUntilTerminal(paymentId);

  saveState({ paymentId });
  return {
    paymentId,
    walletAccountId,
    beneficiaryCounterpartyId: beneficiaryId,
    finalAmount: terminal.actual?.to?.amount ?? "0",
    transactionHash: terminal.steps?.[0]?.transaction_hash ?? "",
  };
}

async function findOrCreateFundingBank(): Promise<string> {
  const accounts = await getAll<{
    id: string;
    type: string;
    is_managed?: boolean | null;
    tenant_id?: string | null;
    counterparty_id?: string | null;
  }>("/v1/accounts");
  const existing = accounts.find(
    (a) =>
      a.type === "fiat_bank" &&
      !a.is_managed &&
      !a.tenant_id &&
      !a.counterparty_id,
  );
  if (existing) return existing.id;
  const created = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name: "Depositing Bank",
    bank_name: "Hancock Whitney Bank",
    bank_code_type: "ROUTING",
    bank_identifier_code: "065400153",
    bank_account_number: "000999999991",
    tenant_id: null,
    counterparty_id: null,
    bank_swift_code: "BARCGB22",
  });
  return created.data.id;
}

async function createPaymentWhenReady(
  payload: Record<string, unknown>,
): Promise<string> {
  const intervalMs = 10_000;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (true) {
    try {
      const res = await post<{ data: { id: string } }>("/v1/payments", payload);
      return res.data.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("payments-3017")) throw err;
      if (Date.now() >= deadline) {
        throw new Error("Wallet risk-approval retry budget exhausted");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}

interface PaymentResource {
  steps?: {
    step_sequence: number;
    status: string;
    transaction_hash?: string | null;
    status_reasons?: unknown;
  }[];
  actual?: { to?: { amount?: string } };
}

async function pollUntilTerminal(paymentId: string): Promise<PaymentResource> {
  const intervalMs = 10_000;
  const deadline = Date.now() + 25 * 60 * 1000;
  while (true) {
    const res = await get<{ data: PaymentResource }>(`/v1/payments/${paymentId}`);
    const failed = res.data.steps?.find((s) => s.status === "failed");
    if (failed) {
      throw new Error(`Payment step ${failed.step_sequence} failed`);
    }
    if (res.data.actual?.to?.amount) return res.data;
    if (Date.now() >= deadline) {
      throw new Error(`Payment ${paymentId} did not terminate within 25 min`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.main) {
  await authenticate();
  const result = await tutorial();
  console.log(
    `Payment ${pc.cyan(result.paymentId)} complete. ` +
      `Sent ${result.finalAmount} USDC. ` +
      `Tx hash: ${result.transactionHash.slice(0, 16)}…`,
  );
}
