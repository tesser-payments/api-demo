import { join } from "node:path";
import { get } from "../client.ts";
import type { Account, Envelope, Payment, Step } from "../types.ts";

/** Where the signer reads its Turnkey API key from. */
export const SIGNING_VARIABLES = ["SIGNING_PUBLIC_KEY", "SIGNING_PRIVATE_KEY", "SIGNING_ENCLAVE_ID"] as const;

/** The launcher `bun run build:signer` installs (signers/kotlin). */
export const KOTLIN_SIGNER = join(import.meta.dir, "../../signers/kotlin/build/install/sign-step/bin/sign-step");

/** The Kotlin SDK's `StepForSigning`. */
export interface StepForSigning {
  id: string;
  transferId: string;
  unsignedTransaction: string;
  signWith: string;
  network: string;
}

/** Sign a payment step with the Kotlin SDK; `signWith` is its `estimated.from.account_id`'s address, as the guide says. */
export async function signWithKotlinSdk(step: Step, payment: Payment): Promise<string> {
  const { account_id: sourceAccountId, network } = step.estimated.from;
  if (!step.unsigned_transaction) throw new Error(`Step ${step.id} has no unsigned transaction to sign`);
  if (!network) throw new Error(`Step ${step.id} has no source network to sign for`);
  if (!sourceAccountId) throw new Error(`Step ${step.id} has no source account to sign with`);
  const { data: source } = await get<Envelope<Account>>(`/v1/accounts/${sourceAccountId}`);
  if (!source.crypto_wallet_address) throw new Error(`Account ${source.id} has no wallet address to sign with`);

  return runKotlinSigner({
    id: step.id,
    transferId: payment.id,
    unsignedTransaction: step.unsigned_transaction,
    signWith: source.crypto_wallet_address,
    network,
  });
}

/** Run the signer on one step and return its `signature`; the key comes from `SIGNING_VARIABLES`. */
export async function runKotlinSigner(stepForSigning: StepForSigning): Promise<string> {
  const signer = Bun.spawn([KOTLIN_SIGNER], {
    env: signerEnvironment(),
    stdin: new Blob([JSON.stringify(stepForSigning)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [signature, error, exitCode] = await Promise.all([
    new Response(signer.stdout).text(),
    new Response(signer.stderr).text(),
    signer.exited,
  ]);
  if (exitCode !== 0) throw new Error(`The Kotlin signer failed: ${error.trim()}`);
  return signature.trim();
}

// Only what the JVM needs to start and sign: the API credentials stay out of it.
function signerEnvironment(): Record<string, string> {
  const names = ["PATH", "JAVA_HOME", ...SIGNING_VARIABLES];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name];
      return value ? [[name, value]] : [];
    }),
  );
}
