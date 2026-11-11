import { createCounterpartyBank, createUnmanagedWallet, findCounterpartyAccount } from "../../src/api/accounts.ts";
import { createBusinessCounterparty, createIndividualCounterparty } from "../../src/api/entities.ts";
import { runKotlinSigner, SIGNING_VARIABLES } from "../../src/setup/kotlin-signer.ts";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the E2E tests`);
  return value;
}

/** Sign a throwaway step locally, so a missing build, JVM or key fails before any payment is created. */
export async function requireKotlinSigner(): Promise<void> {
  for (const name of SIGNING_VARIABLES) requireEnv(name);
  try {
    await runKotlinSigner("sign-step", {
      id: "preflight",
      transferId: "preflight",
      unsignedTransaction: "0x02",
      signWith: "0x0000000000000000000000000000000000000000",
      network: "POLYGON_AMOY",
    });
  } catch (error) {
    throw new Error(
      `The Kotlin signer can't sign: ${(error as Error).message}. Run \`bun run build:signer\` and point JAVA_HOME at a JDK 17–23`,
    );
  }
}

/** The bank account `name` of a business counterparty of the same name, created on first use. */
export async function findOrCreateOriginatorBank(name: string): Promise<string> {
  const existing = await findCounterpartyAccount({ type: "fiat_bank", name });
  if (existing) return existing.id;
  const originator = await createBusinessCounterparty({ name });
  return createCounterpartyBank({ counterpartyId: originator.id, name });
}

/** A counterparty's unmanaged EVM wallet `name` at `address`, created on first use. */
export async function findOrCreateBeneficiaryWallet({ name, address }: { name: string; address: string }): Promise<string> {
  const existing = await findCounterpartyAccount({ type: "stablecoin_ethereum", name });
  if (existing) {
    if (existing.crypto_wallet_address?.toLowerCase() !== address.toLowerCase()) {
      throw new Error(
        `The wallet named "${name}" is at ${existing.crypto_wallet_address}, not ${address}; delete it so the E2E creates it again`,
      );
    }
    return existing.id;
  }
  const beneficiary = await createIndividualCounterparty();
  return createUnmanagedWallet({
    counterpartyId: beneficiary.id,
    name,
    payout: { walletType: "stablecoin_ethereum", address },
  });
}
