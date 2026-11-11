import { join } from "node:path";
import { createManagedEvmWallet, getAccount } from "../api/accounts.ts";
import { apiBaseUrl } from "../client.ts";
import type { Account, Payment, Rebalance, Step } from "../types.ts";

export const SIGNING_VARIABLES = ["SIGNING_PUBLIC_KEY", "SIGNING_PRIVATE_KEY", "SIGNING_ENCLAVE_ID"] as const;

/** The launcher `bun run build:signer` installs (signers/kotlin). */
export const KOTLIN_SIGNER = join(import.meta.dir, "../../signers/kotlin/build/install/tesser-signer/bin/tesser-signer");

/** What each signer command reads on stdin: the Kotlin SDK's `StepForSigning` and `CreateWalletParams`. */
interface SignerInputs {
  "sign-step": { id: string; transferId: string; unsignedTransaction: string; signWith: string; network: string };
  "create-wallet": { name: string; type: "stablecoin_ethereum" };
}

/** A managed EVM wallet created with the signature the Kotlin SDK stamps for `name`. */
export async function createWalletWithKotlinSdk(name: string): Promise<Account> {
  const signature = await runKotlinSigner("create-wallet", { name, type: "stablecoin_ethereum" });
  return createManagedEvmWallet({ name, signature });
}

/**
 * Sign a payment's or rebalance's step with the Kotlin SDK; `signWith` is its
 * `estimated.from.account_id`'s address, as the guide says.
 */
export async function signWithKotlinSdk(step: Step, transfer: Pick<Payment | Rebalance, "id">): Promise<string> {
  const { account_id: sourceAccountId, network } = step.estimated.from;
  if (!step.unsigned_transaction) throw new Error(`Step ${step.id} has no unsigned transaction to sign`);
  if (!network) throw new Error(`Step ${step.id} has no source network to sign for`);
  if (!sourceAccountId) throw new Error(`Step ${step.id} has no source account to sign with`);
  const source = await getAccount(sourceAccountId);
  if (!source.crypto_wallet_address) throw new Error(`Account ${source.id} has no wallet address to sign with`);

  return runKotlinSigner("sign-step", {
    id: step.id,
    transferId: transfer.id,
    unsignedTransaction: step.unsigned_transaction,
    signWith: source.crypto_wallet_address,
    network,
  });
}

/** Run one signer command and return its `signature`; the key comes from `SIGNING_VARIABLES`. */
export async function runKotlinSigner<C extends keyof SignerInputs>(command: C, input: SignerInputs[C]): Promise<string> {
  const signer = Bun.spawn([KOTLIN_SIGNER, command], {
    env: signerEnvironment(),
    stdin: new Blob([JSON.stringify(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [signature, error, exitCode] = await Promise.all([
    new Response(signer.stdout).text(),
    new Response(signer.stderr).text(),
    signer.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The Kotlin signer failed: ${error.trim()}`);
  if (!signature.trim()) throw new Error("The Kotlin signer exited without printing a signature");
  return signature.trim();
}

// Only what the JVM needs to start, sign and reach the same API: the API credentials stay out of it.
function signerEnvironment(): Record<string, string> {
  const names = ["PATH", "JAVA_HOME", ...SIGNING_VARIABLES];
  const passed = names.flatMap((name) => {
    const value = process.env[name];
    return value ? [[name, value]] : [];
  });
  return { ...Object.fromEntries(passed), TESSER_BASE_URL: apiBaseUrl() };
}
