import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, post } from "../src/client.ts";

export const meta = {
  name: "Create a stablecoin payout",
  description:
    "USDC outbound from a Circle Mint ledger to a self-custodial Stellar wallet. " +
    "Creates the beneficiary counterparty + wallet inline, posts the payment with " +
    "the DEA `desired` overlay, then polls until `actual.to.amount` populates.",
  docUrl:
    "https://docs.tesser.xyz/how-tos/send-a-stablecoin-payout/create-a-stablecoin-payout",
} as const;

export interface StablecoinPayoutInput {
  /** Source Circle Mint ledger account ID (must have USDC balance). */
  ledgerAccountId: string;
  /** Optional org-level funding bank for fee coverage; mirrors index.ts. */
  fundingAccountId?: string;
  /** Amount of USDC to send. Decimal string. */
  amount: string;
  /**
   * Self-custodial Stellar wallet address (USDC trustline required).
   * Defaults to `process.env.BENEFICIARY_WALLET_ADDRESS`.
   */
  beneficiaryWalletAddress?: string;
  /** Optional tenant ID. Counterparty + wallet inherit it. */
  tenantId?: string;
}

export interface StablecoinPayoutResult {
  paymentId: string;
  beneficiaryCounterpartyId: string;
  walletAccountId: string;
  payment: PaymentResponse;
}

export interface PaymentResponse {
  id: string;
  direction?: string;
  desired?: {
    from?: { currency?: string; amount?: string; network?: string };
    to?: { currency?: string; amount?: string; network?: string };
  };
  estimated?: unknown;
  actual?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  steps?: {
    step_sequence: number;
    status: string;
    status_reasons?: string | null;
    finalized_at?: string | null;
    completed_at?: string | null;
  }[];
}

export async function run(
  input: StablecoinPayoutInput,
): Promise<StablecoinPayoutResult> {
  const walletAddress =
    input.beneficiaryWalletAddress ?? process.env.BENEFICIARY_WALLET_ADDRESS;
  if (!walletAddress) {
    throw new Error(
      "beneficiaryWalletAddress is required (pass it or set BENEFICIARY_WALLET_ADDRESS).",
    );
  }

  // 1. Create the beneficiary counterparty. Randomized individual vs business
  //    matches what index.ts does; either is valid for a payout recipient.
  const beneficiary = await createBeneficiary(input.tenantId);
  console.log(
    `  Beneficiary: ${beneficiary.name} ${pc.dim(`(${beneficiary.id})`)}`,
  );

  // 2. Create an unmanaged Stellar wallet account tied to the beneficiary.
  const walletName = `${beneficiary.name}'s Wallet`;
  const walletPayload: Record<string, unknown> = {
    name: walletName,
    type: "stablecoin_stellar",
    is_managed: false,
    wallet_address: walletAddress,
    counterparty_id: beneficiary.id,
  };
  if (input.tenantId) walletPayload.tenant_id = input.tenantId;
  const wallet = await post<{ data: { id: string } }>(
    "/v1/accounts/wallets",
    walletPayload,
  );
  const walletAccountId = wallet.data.id;
  console.log(`  Wallet account: ${pc.cyan(walletAccountId)}`);

  // 3. Create the payment. Uses the new DEA `desired` overlay shape.
  const paymentPayload: Record<string, unknown> = {
    desired: {
      from: {
        account_id: input.ledgerAccountId,
        amount: input.amount,
        currency: "USDC",
        network: "STELLAR",
      },
      to: {
        account_id: walletAccountId,
        currency: "USDC",
        network: "STELLAR",
      },
    },
  };
  if (input.fundingAccountId) paymentPayload.funding_account_id = input.fundingAccountId;
  const created = await post<{ data: PaymentResponse }>(
    "/v1/payments",
    paymentPayload,
  );
  const paymentId = created.data.id;
  console.log(`  Payment ID: ${pc.cyan(paymentId)}`);

  // 4. Poll the payment resource until DEA `actual.to.amount` populates.
  const terminal = await pollPaymentTerminal(paymentId);

  return {
    paymentId,
    beneficiaryCounterpartyId: beneficiary.id,
    walletAccountId,
    payment: terminal,
  };
}

async function createBeneficiary(
  tenantId?: string,
): Promise<{ id: string; name: string }> {
  const isIndividual = Math.random() > 0.5;
  let name: string;
  let payload: Record<string, unknown>;

  if (isIndividual) {
    const firstName = faker.person.firstName();
    const lastName = faker.person.lastName();
    name = `${firstName} ${lastName}`;
    payload = {
      classification: "individual",
      individual_first_name: firstName,
      individual_last_name: lastName,
      individual_address_country: "US",
      individual_street_address1: faker.location.streetAddress(),
      individual_city: faker.location.city(),
      individual_state: faker.location.state({ abbreviated: true }),
      individual_postal_code: faker.location.zipCode(),
    };
  } else {
    name = faker.company.name();
    payload = {
      classification: "business",
      business_legal_name: name,
      business_dba: name,
      business_address_country: "US",
      business_street_address1: faker.location.streetAddress(),
      business_city: faker.location.city(),
      business_state: faker.location.state({ abbreviated: true }),
      business_postal_code: faker.location.zipCode(),
      business_legal_entity_identifier: faker.string.alphanumeric({
        length: 20,
        casing: "upper",
      }),
    };
  }
  if (tenantId) payload.tenant_id = tenantId;

  const res = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    payload,
  );
  return { id: res.data.id, name };
}

async function pollPaymentTerminal(paymentId: string): Promise<PaymentResponse> {
  // Stellar settlement is generally fast (~30s) but allow generous headroom.
  const intervalMs = 10_000;
  const deadline = Date.now() + 25 * 60 * 1000;
  let lastLog = "";
  while (true) {
    const res = await get<{ data: PaymentResponse }>(`/v1/payments/${paymentId}`);
    const p = res.data;
    const failed = p.steps?.find((s) => s.status === "failed");
    if (failed) {
      throw new Error(
        `Payment step ${failed.step_sequence} failed: ${failed.status_reasons}`,
      );
    }
    const log = (p.steps ?? [])
      .map((s) => `step${s.step_sequence}=${s.status}`)
      .join(", ");
    if (log !== lastLog) {
      console.log(pc.yellow(`  Poll: ${log}`));
      lastLog = log;
    }
    if (p.actual?.to?.amount) {
      console.log(
        pc.green(`  Payment terminal: actual.to=${p.actual.to.amount}`),
      );
      return p;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Payment ${paymentId} did not terminate within 25 min`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.main) {
  await authenticate();
  const ledgerAccountId = process.env.TESSER_FROM_ACCOUNT_ID;
  if (!ledgerAccountId) {
    throw new Error(
      "TESSER_FROM_ACCOUNT_ID env var required for standalone run " +
        "(set to an existing USDC-funded Circle Mint ledger account).",
    );
  }
  const result = await run({
    ledgerAccountId,
    amount: process.env.TESSER_TEST_PAYOUT_AMOUNT ?? "0.01",
  });
  console.log(pc.green(`\nPayment ${result.paymentId} complete.`));
}
