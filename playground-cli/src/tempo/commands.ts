import { Command, Option } from "commander";
import { PlaygroundError, UsageError } from "../errors.ts";
import {
  broadcastTempoTransfer, inspectTempo, prepareTempoTransfer, readTempoBalances, readTempoReceipt,
  signTempoTransfer, type TempoOptions, type TempoRuntime,
} from "./workflows.ts";

type TempoAction = (runtime: TempoRuntime, options: TempoOptions) => Promise<void>;

async function runAction(action: TempoAction, runtime: TempoRuntime, options: TempoOptions) {
  try {
    await action(runtime, options);
  } catch (error) {
    if (error instanceof PlaygroundError || (error instanceof Error && error.name === "ExitPromptError")) throw error;
    throw new PlaygroundError("Tempo command failed; provider payloads and signing material are omitted from errors");
  }
}

export function registerTempoCommands(program: Command, contextFor: (command: Command) => Promise<TempoRuntime>): void {
  const tempo = program.command("tempo", { hidden: true })
    .description("Inspect Tempo and run direct protocol experiments")
    .action(async (_options: unknown, command: Command) => {
      await runTempoMenu(await contextFor(command));
    });
  const cliOnly = tempo.command("cli-only")
    .description("Call Tempo RPC and Turnkey directly, using disposable Moderato wallets for sends")
    .addOption(new Option("--network <network>", "Explicit chain selection").choices(["mainnet", "moderato"]))
    .action(async (_options: unknown, command: Command) => {
      await runTempoMenu(await contextFor(command), command.optsWithGlobals<TempoOptions>());
    });
  registerTempoOperations(cliOnly, contextFor);
}

export function registerTempoExperimentCommands(
  parent: Command,
  contextFor: (command: Command) => Promise<TempoRuntime>,
): void {
  const tempo = parent.command("tempo")
    .description("Run direct Tempo RPC and Turnkey operations")
    .addOption(new Option("--network <network>", "Explicit chain selection").choices(["mainnet", "moderato"]))
    .action(async (_options: unknown, command: Command) => {
      await runTempoMenu(await contextFor(command), command.optsWithGlobals<TempoOptions>());
    });
  registerTempoOperations(tempo, contextFor);
}

function registerTempoOperations(
  parent: Command,
  contextFor: (command: Command) => Promise<TempoRuntime>,
): void {
  const register = (command: Command, action: TempoAction) => command.action(async (_options: unknown, selected: Command) =>
    runAction(action, await contextFor(selected), selected.optsWithGlobals<TempoOptions>()));
  const assetOptions = (command: Command) => command
    .addOption(new Option("--currency <currency>", "Configured currency mapping").choices(["USDC", "USDT"]))
    .option("--token-address <address>", "Override the contract for this experiment; display its onchain identity");

  register(assetOptions(parent.command("inspect").description("Read chain ID and TIP-20 metadata")), inspectTempo);
  register(assetOptions(parent.command("balances").description("Read token balances at one block"))
    .option("--address <address>", "Wallet address to inspect"), readTempoBalances);
  register(assetOptions(parent.command("prepare").description("Prepare an unsigned Moderato token transfer; no signing or broadcast"))
    .option("--from <address>", "Disposable source EVM address")
    .option("--to <address>", "Test recipient EVM address")
    .option("--amount <amount>", "Exact token amount")
    .addOption(new Option("--format <format>", "Transaction format experiment").choices(["tempo", "eip1559"]))
    .option("--sponsored", "Pay AlphaUSD fees with TEMPO_SPONSOR_PRIVATE_KEY")
    .option("--fee-token <address>", "Required for sender-paid native Tempo; sponsorship uses AlphaUSD")
    .option("--gas-limit <units>", "Explicit gas limit instead of an RPC estimate")
    .option("--max-fee-per-gas <units>", "Integer gas-price units (USD at 18 decimal places)")
    .option("--max-priority-fee-per-gas <units>", "Integer priority gas-price units")
    .option("--out <path>", "New private file for the unsigned transaction"), prepareTempoTransfer);
  register(parent.command("sign").description("Obtain the Turnkey signature and any configured sponsor signature; no broadcast")
    .option("--file <path>", "Prepared transaction file")
    .option("--out <path>", "New private file for the signed transaction")
    .addOption(new Option("--turnkey-type <type>", "Explicit Turnkey signing experiment")
      .choices(["TRANSACTION_TYPE_TEMPO", "TRANSACTION_TYPE_ETHEREUM"]))
    .option("--activity-id <id>", "Read an existing signing activity instead of requesting another signature"), signTempoTransfer);
  register(parent.command("broadcast").description("Submit a signed Moderato transaction once; an existing record resumes observation")
    .option("--file <path>", "Signed transaction file")
    .option("--record <path>", "Broadcast attempt and balance evidence file"), broadcastTempoTransfer);
  register(parent.command("receipt").description("Read receipt, actual token movements, fee evidence, and block balances")
    .option("--hash <hash>", "Transaction hash, including one without a local record")
    .option("--record <path>", "Broadcast record supplying the hash, intent, and before balances"), readTempoReceipt);
}

export async function runTempoMenu(runtime: TempoRuntime, options: TempoOptions = {}): Promise<boolean> {
  if (!runtime.interaction.interactive) {
    throw new UsageError("Choose a provider-experiments tempo subcommand in non-interactive mode");
  }
  const actions = { inspect: inspectTempo, balances: readTempoBalances, prepare: prepareTempoTransfer, sign: signTempoTransfer, broadcast: broadcastTempoTransfer, receipt: readTempoReceipt };
  const selected = await runtime.interaction.choose<keyof typeof actions | "back">("Tempo CLI-only experiments", [
    { name: "Inspect network and tokens (read only)", value: "inspect" },
    { name: "Read wallet balances", value: "balances" },
    { name: "Prepare a test transfer", value: "prepare" },
    { name: "Sign through Turnkey", value: "sign" },
    { name: "Broadcast a signed test transfer", value: "broadcast" },
    { name: "Inspect a receipt by hash (read only)", value: "receipt" },
    { name: "Back", value: "back" },
  ]);
  if (selected === "back") return false;
  await runAction(actions[selected], runtime, options);
  return true;
}
