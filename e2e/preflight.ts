import { createManagedEvmWallet, findManagedEvmWallet } from "../src/api/accounts.ts";
import { findCircleMasterLedger, findCircleWireBank, storeCircleKey } from "../src/setup/circle.ts";
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
