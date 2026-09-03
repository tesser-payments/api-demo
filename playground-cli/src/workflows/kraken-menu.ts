import { CancelledError, UsageError } from "../errors.ts";
import { runKraken, type KrakenRuntime } from "./kraken.ts";
import { runKrakenBalances } from "./kraken-balances.ts";
import { runKrakenSwap } from "./kraken-swap.ts";
import { runKrakenWithdrawMenu } from "./kraken-withdraw.ts";

export async function runKrakenMenu(runtime: KrakenRuntime): Promise<void> {
  if (!runtime.interaction.interactive) {
    throw new UsageError("A Kraken subcommand is required in non-interactive mode");
  }
  while (true) {
    const selection = await runtime.interaction.choose("Kraken", [
      { name: "Balances", value: "balances" },
      { name: "Deposit", value: "deposit" },
      { name: "Swap USD to USDC", value: "swap" },
      { name: "Withdraw USDC", value: "withdraw" },
      { name: "Back", value: "back" },
    ] as const);
    if (selection === "back") return;
    try {
      if (selection === "balances") await runKrakenBalances(runtime);
      if (selection === "deposit") await runKraken(runtime, {});
      if (selection === "swap") await runKrakenSwap(runtime);
      if (selection === "withdraw") await runKrakenWithdrawMenu(runtime);
    } catch (error) {
      if (error instanceof CancelledError) runtime.output.info(error.message);
      else if (error instanceof Error) runtime.output.error(error.message);
      else runtime.output.error(String(error));
    }
  }
}
