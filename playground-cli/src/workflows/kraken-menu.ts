import { krakenEnvironmentVariables } from "../config.ts";
import { UsageError } from "../errors.ts";
import type { Runtime } from "../runtime.ts";
import { runKraken, type KrakenRuntime } from "./kraken.ts";
import { runKrakenBalances } from "./kraken-balances.ts";
import { runKrakenCliOnlyDeposit } from "./kraken-cli-only-deposit.ts";
import { runKrakenDeposit } from "./kraken-e2e-deposit.ts";
import { runKrakenRegisterSecrets } from "./kraken-register-secrets.ts";
import { runKrakenSwap } from "./kraken-swap.ts";
import { runKrakenWithdrawMenu } from "./kraken-withdraw.ts";

type KrakenMenuContext = Pick<Runtime, "environment" | "interaction" | "output"> & {
  runtime(operation: string, additionalVariables?: readonly string[]): Runtime;
  krakenRuntime(operation: string): KrakenRuntime;
};

function tesserRuntime(
  context: KrakenMenuContext,
  operation: string,
  additionalVariables: readonly string[] = [],
): Runtime {
  return context.runtime(operation, additionalVariables);
}

function krakenRuntime(context: KrakenMenuContext, operation: string): KrakenRuntime {
  return context.krakenRuntime(operation);
}

export async function runKrakenMenu(context: KrakenMenuContext): Promise<void> {
  if (!context.interaction.interactive) {
    throw new UsageError("A Kraken subcommand is required in non-interactive mode");
  }
  const selection = await context.interaction.choose("Kraken", [
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
  if (selection === "register-secrets") {
    await runKrakenRegisterSecrets(
      tesserRuntime(context, "Workspace: register Kraken secrets", krakenEnvironmentVariables),
      {},
    );
  }
  if (selection === "deposit") await runKrakenDeposit(tesserRuntime(context, "Treasury: deposit"), {});
  if (selection === "balances") {
    await runKrakenBalances(krakenRuntime(context, "Provider experiments: Kraken balances"));
  }
  if (selection === "funding-deposit") {
    await runKraken(krakenRuntime(context, "Provider experiments: Kraken deposit"), {});
  }
  if (selection === "swap") {
    await runKrakenSwap(krakenRuntime(context, "Provider experiments: Kraken swap"));
  }
  if (selection === "withdraw") await runKrakenWithdrawMenu(context);
  if (selection === "cli-only") await runKrakenCliOnlyMenu(context);
}

export async function runKrakenCliOnlyMenu(context: KrakenMenuContext): Promise<void> {
  if (!context.interaction.interactive) {
    throw new UsageError("A Kraken CLI-only subcommand is required in non-interactive mode");
  }
  const selection = await context.interaction.choose("Kraken CLI-only prototypes", [
    { name: "BRL-to-USDC deposit through Kraken", value: "deposit" },
    { name: "Back", value: "back" },
  ] as const);
  if (selection === "back") return;
  await runKrakenCliOnlyDeposit(
    krakenRuntime(context, "Provider experiments: Kraken BRL-to-USDC flow"),
    {},
  );
}
