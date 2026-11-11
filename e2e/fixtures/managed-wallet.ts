import { authenticate } from "../../src/client.ts";
import { getAvailableBalance, waitForBalance } from "../../src/api/accounts.ts";
import { simulateInbound } from "../../src/api/payments.ts";
import { createWalletWithKotlinSdk } from "../../src/setup/kotlin-signer.ts";
import { waitForPayment } from "../../src/steps.ts";
import type { Account } from "../../src/types.ts";
import { requireKotlinSigner } from "./preflight.ts";

// Polygon Amoy finalizes within seconds, and the outbound risk-test addresses work on it.
export const NETWORK = "POLYGON_AMOY";
// simulate-inbound always sends exactly 1 USDC.
export const INBOUND_AMOUNT = 1;
export const RUN_ID = crypto.randomUUID().slice(0, 8);
export const RUN_WALLET_NAME = `E2E managed wallet ${RUN_ID}`;
export const PAYMENT_TIMEOUT_MS = 5 * 60_000;
export const BALANCE_HOLD_MS = 30_000;
// Creating the wallet and one top-up inbound, for a file run on its own.
export const FUNDING_TIMEOUT_MS = 14 * 60_000;

export const exactly = (amount: number) => amount.toFixed(6);
export const usdcOf = (accountId: string) => ({ accountId, currency: "USDC", network: NETWORK });

let runWalletCreation: Promise<Account> | undefined;

/**
 * This run's managed wallet, created with the Kotlin SDK on first use. Bun runs
 * every test file in one process, so all files share it: one wallet per run.
 */
export function runWallet(): Promise<Account> {
  runWalletCreation ??= (async () => {
    await requireKotlinSigner();
    await authenticate();
    return createWalletWithKotlinSdk(RUN_WALLET_NAME);
  })();
  return runWalletCreation;
}

/** The run's wallet holding at least `minimum` USDC, topped up with automatically approved inbounds if it holds less. */
export async function fundedRunWallet(minimum: number): Promise<Account> {
  const wallet = await runWallet();
  let balance = parseFloat(await getAvailableBalance(usdcOf(wallet.id)));
  while (balance < minimum) {
    const paymentId = await simulateInbound({ toAccountId: wallet.id, mockedRiskStatus: "automatically_approved", network: NETWORK });
    balance += INBOUND_AMOUNT;
    await waitForBalance({ ...usdcOf(wallet.id), amount: exactly(balance) });
    await waitForPayment(paymentId, { timeoutMs: PAYMENT_TIMEOUT_MS });
  }
  return wallet;
}
