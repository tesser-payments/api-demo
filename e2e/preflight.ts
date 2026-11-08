import {
  createCounterpartyBank,
  createManagedEvmWallet,
  createUnmanagedWallet,
  findCounterpartyAccount,
  findManagedEvmWallet,
} from "../src/api/accounts.ts";
import { createBusinessCounterparty, createIndividualCounterparty } from "../src/api/entities.ts";
import { findCircleMasterLedger, findCircleWireBank, storeCircleKey } from "../src/setup/circle.ts";
import { runKotlinSigner, SIGNING_VARIABLES } from "../src/setup/kotlin-signer.ts";
import { signCreateEvmWallet, type TurnkeyCredentials } from "../src/setup/turnkey.ts";
import type { Account } from "../src/types.ts";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the E2E tests`);
  return value;
}

/**
 * Connect Circle and check the setup that can't be done through the Tesser
 * API, so a broken environment fails here instead of as a timeout mid-flow.
 */
export async function prepareCircle(): Promise<void> {
  const apiKey = requireEnv("CIRCLE_API_KEY");
  await storeCircleKey(apiKey);
  await findCircleMasterLedger();
  await findCircleWireBank(apiKey);
}

/** The workspace's managed EVM wallet named `name`, created with `turnkey` when missing. */
export async function findOrCreateManagedWallet(
  name: string,
  turnkey: TurnkeyCredentials | undefined,
): Promise<Account> {
  const existing = await findManagedEvmWallet(name);
  if (existing) return existing;

  if (!turnkey) {
    throw new Error(
      `No managed wallet named "${name}". Set the TURNKEY_* variables so the E2E creates it, or create it once in the dashboard (an EVM wallet owned by the workspace)`,
    );
  }
  const signature = await signCreateEvmWallet(name, turnkey);
  return createManagedEvmWallet({ name, signature });
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
