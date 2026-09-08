import { CancelledError, UsageError } from "../errors.ts";
import type { Runtime } from "../runtime.ts";
import { runKraken } from "./kraken.ts";
import { runKrakenBalances } from "./kraken-balances.ts";
import { runKrakenCliOnlyDeposit } from "./kraken-cli-only-deposit.ts";
import { runKrakenDeposit } from "./kraken-e2e-deposit.ts";
import { runKrakenRegisterSecrets } from "./kraken-register-secrets.ts";
import { runKrakenSwap } from "./kraken-swap.ts";
import { runKrakenWithdrawMenu } from "./kraken-withdraw.ts";

export async function runKrakenMenu(runtime: Runtime): Promise<void> {
  if (!runtime.interaction.interactive) {
    throw new UsageError("A Kraken subcommand is required in non-interactive mode");
  }
  while (true) {
    const selection = await runtime.interaction.choose("Kraken", [
      { name: "Register secrets", value: "register-secrets" },
      { name: "BRL deposit through Tesser", value: "deposit" },
      { name: "Balances", value: "balances" },
      { name: "Direct Funding API deposit", value: "funding-deposit" },
      { name: "Swap BRL or USD to USDC", value: "swap" },
      { name: "Withdraw USDC", value: "withdraw" },
      { name: "CLI-only prototypes", value: "cli-only" },
      { name: "Back", value: "back" },
    ] as const);
    if (selection === "back") return;
    try {
      if (selection === "register-secrets") {
        await runKrakenRegisterSecrets(runtime, {});
      }
      if (selection === "deposit") await runKrakenDeposit(runtime, {});
      if (selection === "balances") await runKrakenBalances(runtime);
      if (selection === "funding-deposit") await runKraken(runtime, {});
      if (selection === "swap") await runKrakenSwap(runtime);
      if (selection === "withdraw") await runKrakenWithdrawMenu(runtime);
      if (selection === "cli-only") await runKrakenCliOnlyMenu(runtime);
    } catch (error) {
      if (error instanceof CancelledError) runtime.output.info(error.message);
      else if (error instanceof Error) runtime.output.error(error.message);
      else runtime.output.error(String(error));
    }
  }
}

export async function runKrakenCliOnlyMenu(runtime: Runtime): Promise<void> {
  if (!runtime.interaction.interactive) {
    throw new UsageError("A Kraken CLI-only subcommand is required in non-interactive mode");
  }
  while (true) {
    const selection = await runtime.interaction.choose("Kraken CLI-only prototypes", [
      { name: "BRL-to-USDC deposit through Kraken", value: "deposit" },
      { name: "Back", value: "back" },
    ] as const);
    if (selection === "back") return;
    try {
      if (selection === "deposit") await runKrakenCliOnlyDeposit(runtime, {});
    } catch (error) {
      if (error instanceof CancelledError) runtime.output.info(error.message);
      else if (error instanceof Error) runtime.output.error(error.message);
      else runtime.output.error(String(error));
    }
  }
}
