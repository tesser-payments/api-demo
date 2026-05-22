import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, getAll, post } from "../src/client.ts";

export const meta = {
  name: "Create a stablecoin payout",
  description:
    "Stablecoin outbound from a Circle Mint ledger to a self-custodial wallet. " +
    "Network and currency are inputs; defaults to USDC on Stellar. Creates the " +
    "beneficiary counterparty + wallet inline, posts the payment with the DEA " +
    "`desired` overlay, then polls until `actual.to.amount` populates.",
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
  /**
   * Currency to send. Defaults to "USDC".
   */
  currency?: string;
  /**
   * On-chain network. Defaults to "STELLAR". Use a value from the
   * `/v1/networks` `key` field.
   */
  network?: string;
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
  expires_at?: string;
  risk_status?: string;
  balance_status?: string;
  desired?: {
    from?: { account_id?: string; currency?: string; amount?: string; network?: string };
    to?: { account_id?: string; currency?: string; amount?: string; network?: string };
  };
  estimated?: {
    from?: { currency?: string; amount?: string; network?: string };
    to?: { currency?: string; amount?: string; network?: string };
  };
  actual?: {
    from?: { currency?: string; amount?: string; network?: string };
    to?: { currency?: string; amount?: string; network?: string };
  };
  steps?: {
    step_sequence: number;
    status: string;
    status_reasons?: string[] | string | null;
    provider_key?: string;
    step_type?: string;
    transaction_hash?: string | null;
    fees?: unknown[];
    submitted_at?: string | null;
    confirmed_at?: string | null;
    finalized_at?: string | null;
    completed_at?: string | null;
  }[];
}

type AddressClass = "STELLAR" | "EVM";

// EVM-compatible chains all share Ethereum-style 0x... addresses and use
// the same `stablecoin_ethereum` account type. Sandbox uses testnet
// identifiers (POLYGON_AMOY, BASE_SEPOLIA, etc.) — add either mainnet or
// testnet keys here as the platform exposes them.
const EVM_NETWORKS = new Set([
  "ETHEREUM",
  "ETHEREUM_SEPOLIA",
  "POLYGON",
  "POLYGON_AMOY",
  "BASE",
  "BASE_SEPOLIA",
  "AVALANCHE",
  "ARBITRUM",
  "OPTIMISM",
  "BSC",
]);

export function networkAddressClass(network: string): AddressClass | undefined {
  if (network === "STELLAR") return "STELLAR";
  if (EVM_NETWORKS.has(network)) return "EVM";
  return undefined;
}

const ADDRESS_CLASS_TO_WALLET_TYPE: Record<AddressClass, string> = {
  STELLAR: "stablecoin_stellar",
  EVM: "stablecoin_ethereum",
};

/**
 * Resolves the recipient wallet address from env vars. One address per
 * address-class — EVM chains all share `BENEFICIARY_WALLET_ADDRESS_EVM`
 * because they use the same 0x... address format. STELLAR also falls
 * back to the legacy `BENEFICIARY_WALLET_ADDRESS` for backwards compat.
 * Returns undefined when no usable env var is set (test should skip).
 */
export function resolveWalletAddress(network: string): string | undefined {
  const klass = networkAddressClass(network);
  if (!klass) return undefined;
  const fromClassEnv = process.env[`BENEFICIARY_WALLET_ADDRESS_${klass}`];
  if (fromClassEnv) return fromClassEnv;
  if (klass === "STELLAR") return process.env.BENEFICIARY_WALLET_ADDRESS;
  return undefined;
}

export async function run(
  input: StablecoinPayoutInput,
): Promise<StablecoinPayoutResult> {
  const network = input.network ?? "STELLAR";
  const currency = input.currency ?? "USDC";
  console.log(pc.dim(`  Payout: ${currency} on ${network}`));

  const klass = networkAddressClass(network);
  if (!klass) {
    throw new Error(
      `Unsupported network ${network}: not classified as STELLAR/SOLANA/EVM. ` +
        `Add it to EVM_NETWORKS or networkAddressClass() in create-a-stablecoin-payout.ts.`,
    );
  }
  const walletAddress =
    input.beneficiaryWalletAddress ?? resolveWalletAddress(network);
  if (!walletAddress) {
    throw new Error(
      `beneficiaryWalletAddress is required for network=${network} ` +
        `(set BENEFICIARY_WALLET_ADDRESS_${klass} in .env, or pass beneficiaryWalletAddress).`,
    );
  }

  // 1. Create the beneficiary counterparty. Randomized individual vs business
  //    matches what index.ts does; either is valid for a payout recipient.
  const beneficiary = await createBeneficiary(input.tenantId);
  console.log(
    `  Beneficiary: ${beneficiary.name} ${pc.dim(`(${beneficiary.id})`)}`,
  );

  // 2. Create an unmanaged wallet account tied to the beneficiary.
  const walletType = ADDRESS_CLASS_TO_WALLET_TYPE[klass];
  const walletName = `${beneficiary.name}'s Wallet`;
  const walletPayload: Record<string, unknown> = {
    name: walletName,
    type: walletType,
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
  // funding_account_id is required by the platform even when source and
  // destination are USDC; defaults to the org-level fiat bank.
  const fundingAccountId =
    input.fundingAccountId ?? (await findOrCreateFundingBank());
  const paymentPayload: Record<string, unknown> = {
    funding_account_id: fundingAccountId,
    desired: {
      from: {
        account_id: input.ledgerAccountId,
        amount: input.amount,
        currency,
        network,
      },
      to: {
        account_id: walletAccountId,
        currency,
        network,
      },
    },
  };
  const created = await createPaymentWhenReady(paymentPayload);
  const paymentId = created.id;
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

async function createPaymentWhenReady(
  payload: Record<string, unknown>,
): Promise<PaymentResponse> {
  // Newly-created self-custodial wallets undergo asynchronous risk approval
  // before they can receive a payment. The custodian flips the state from
  // the API side; there's no observable readiness flag on the wallet, so we
  // retry the create-payment call until the wallet is approved.
  const intervalMs = 10_000;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (true) {
    try {
      const res = await post<{ data: PaymentResponse }>("/v1/payments", payload);
      return res.data;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry the wallet risk-approval race. Anything else is real.
      if (!msg.includes("payments-3017")) throw err;
      if (Date.now() >= deadline) {
        throw new Error(
          `Payment could not be created within 5 min: ${msg}`,
        );
      }
      console.log(pc.dim("  Waiting for wallet risk approval..."));
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
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
