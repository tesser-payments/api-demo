import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { NonInteractiveInteraction, TerminalInteraction, type Interaction } from "./interaction.ts";
import { loadEnvironment, type Environment } from "./config.ts";
import { CancelledError, PlaygroundError, UsageError } from "./errors.ts";
import { selectEnvironmentFile } from "./environment-selection.ts";
import { Output } from "./output.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import { runRequest, type RequestCommandOptions } from "./workflows/request.ts";
import { runPayment, type PaymentOptions } from "./workflows/payment.ts";
import { runWithdrawal, type WithdrawalOptions } from "./workflows/withdrawal.ts";
import { runRebalance, type RebalanceOptions } from "./workflows/rebalance.ts";
import { runWalletAddress, type WalletOptions } from "./workflows/wallet.ts";
import { runSimulateInbound, type SimulateInboundOptions } from "./workflows/simulate-inbound.ts";
import {
  createBankAccount,
  deleteBasisTheory,
  patchBasisTheory,
  registerOpenFx,
  showOpenFxWebhookUrl,
  type BankAccountOptions,
} from "./workflows/openfx.ts";
import { runKraken, type KrakenOptions, type KrakenRuntime } from "./workflows/kraken.ts";
import { runKrakenDeposit, type KrakenDepositOptions } from "./workflows/kraken-e2e-deposit.ts";
import { runKrakenBalances } from "./workflows/kraken-balances.ts";
import { runKrakenDepositShow, type KrakenDepositShowOptions } from "./workflows/kraken-deposit.ts";
import { runKrakenMenu } from "./workflows/kraken-menu.ts";
import { runKrakenRegisterSecrets, type KrakenRegisterSecretsOptions } from "./workflows/kraken-register-secrets.ts";
import { runKrakenSwap, type KrakenSwapOptions } from "./workflows/kraken-swap.ts";
import {
  runKrakenRegisterAddress,
  runKrakenWithdraw,
  runKrakenWithdrawMenu,
  type KrakenRegisterAddressOptions,
  type KrakenWithdrawOptions,
} from "./workflows/kraken-withdraw.ts";

type GlobalOptions = {
  envFile?: string;
  nonInteractive?: boolean;
  output: "human" | "json";
  verbose?: boolean;
};

type Context = {
  environment: Environment;
  interaction: Interaction;
  output: Output;
  runtime(): Runtime;
  krakenRuntime(): KrakenRuntime;
};

const program = new Command()
  .name("tesser-playground")
  .description("Interactive and scriptable playground for the Tesser API")
  .option("--env-file <path>", "Load configuration from this file only")
  .option("--non-interactive", "Never prompt or read from the terminal")
  .addOption(new Option("--output <format>", "Output format").choices(["human", "json"]).default("human"))
  .option("-v, --verbose", "Print complete sanitized requests and responses")
  .showHelpAfterError()
  .exitOverride();

program
  .command("request")
  .description("Make an authenticated Tesser API request")
  .argument("[method]", "HTTP method")
  .argument("[path]", "Relative API path")
  .option("-q, --query <pair>", "Query parameter as KEY=VALUE", collect, [])
  .option("-H, --header <pair>", "Header as KEY=VALUE", collect, [])
  .option("-d, --data <json>", "JSON request body")
  .option("-f, --data-file <path>", "JSON body file, or - for stdin")
  .action(
    async (method: string | undefined, path: string | undefined, options: RequestCommandOptions, command: Command) =>
      runRequest((await contextFor(command)).runtime(), method, path, options),
  );

program
  .command("payment")
  .description("Create or resume and sign an outbound wallet payment")
  .argument("[destination-wallet-address]", "Destination on-chain wallet address")
  .option("--payment-id <id>", "Resume an existing payment")
  .option("--source-wallet-id <id>", "Managed source wallet account ID")
  .option("--destination-account-id <id>", "Registered destination account ID")
  .option("--destination-name <name>", "Name for a new destination account")
  .option("--destination-counterparty-id <id>", "Owner for a new destination account")
  .option("--funding-account-id <id>", "Workspace funding bank account ID")
  .option("--amount <amount>", "Payment amount")
  .option("--currency <currency>", "Payment currency")
  .option("--network <network>", "Payment network")
  .option("--organization-reference-id <id>", "Payment organization reference")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .action(async (destinationWalletAddress: string | undefined, options: PaymentOptions, command: Command) =>
    runPayment((await contextFor(command)).runtime(), destinationWalletAddress, options),
  );

program
  .command("withdrawal")
  .description("Create or resume and sign an OpenFX withdrawal")
  .option("--withdrawal-id <id>", "Resume an existing withdrawal")
  .option("--source-wallet-id <id>", "Source wallet account ID")
  .option("--destination-bank-account-id <id>", "Destination bank account ID")
  .option("--amount <amount>", "Withdrawal amount")
  .option("--from-currency <currency>", "Source currency")
  .option("--from-network <network>", "Source network")
  .option("--to-currency <currency>", "Destination currency")
  .option("--organization-reference-id <id>", "Withdrawal organization reference")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--validate-only", "Validate configuration without calling an API")
  .option("--with-ui", "Write a live HTML withdrawal dashboard")
  .action(async (options: WithdrawalOptions, command: Command) =>
    runWithdrawal((await contextFor(command)).runtime(), options),
  );

program
  .command("rebalance")
  .description("Create or resume and sign a wallet-to-OpenFX-ledger rebalance")
  .option("--rebalance-id <id>", "Resume an existing rebalance")
  .option("--source-wallet-id <id>", "Source wallet account ID")
  .option("--destination-ledger-id <id>", "Destination OpenFX ledger account ID")
  .option("--amount <amount>", "Rebalance amount")
  .option("--from-currency <currency>", "Source currency")
  .option("--from-network <network>", "Source network")
  .option("--to-currency <currency>", "Destination ledger currency")
  .option("--organization-reference-id <id>", "Rebalance organization reference")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--validate-only", "Validate configuration without calling an API")
  .option("--with-ui", "Write a live HTML rebalance dashboard")
  .action(async (options: RebalanceOptions, command: Command) =>
    runRebalance((await contextFor(command)).runtime(), options),
  );

program
  .command("wallet-address")
  .description("Resolve a workspace wallet address")
  .option("--wallet-id <id>", "Wallet account ID")
  .option("--currency <currency>", "Wallet asset currency")
  .option("--network <network>", "Wallet asset network")
  .action(async (options: WalletOptions, command: Command) =>
    runWalletAddress((await contextFor(command)).runtime(), options),
  );

program
  .command("simulate-inbound")
  .description("Create one or more simulated inbound sandbox payments")
  .option("--wallet-id <id>", "Destination wallet ID")
  .option("--to-account <id>", "Destination wallet ID")
  .option("--network <network>", "Sandbox network")
  .option("--mocked-risk-status <status>", "Mocked risk status", "automatically_approved")
  .option("--risk-status <status>", "Mocked risk status")
  .option("--count <count>", "Number of simulations", integerOption, 1)
  .option("-y, --yes", "Skip the batch confirmation")
  .action(
    async (
      options: SimulateInboundOptions & {
        toAccount?: string;
        riskStatus?: string;
      },
      command: Command,
    ) =>
      runSimulateInbound((await contextFor(command)).runtime(), {
        ...options,
        walletId: options.walletId ?? options.toAccount,
        mockedRiskStatus: options.riskStatus ?? options.mockedRiskStatus,
      }),
  );

const kraken = program
  .command("kraken")
  .description("Manage Kraken balances, deposits, swaps, and withdrawals")
  .action(async (_options: unknown, command: Command) => runKrakenMenu((await contextFor(command)).runtime()));

kraken
  .command("register_secrets")
  .description("Register Kraken credentials and CAD instructions with Tesser")
  .option("--cad-instructions-file <path>", "Normalized Kraken CAD deposit instructions JSON")
  .action(async (options: KrakenRegisterSecretsOptions, command: Command) =>
    runKrakenRegisterSecrets((await contextFor(command)).runtime(), options),
  );

kraken
  .command("balances")
  .description("Show Kraken extended balances")
  .action(async (_options: unknown, command: Command) => {
    await runKrakenBalances((await contextFor(command)).krakenRuntime());
  });

kraken
  .command("deposit")
  .description("Create or resume a Tesser BRL deposit into Kraken")
  .option("--deposit-id <id>", "Resume an existing Tesser deposit")
  .option("--source-bank-id <id>", "Workspace source bank account ID")
  .option("--kraken-ledger-id <id>", "Managed Kraken ledger account ID")
  .option("--amount <amount>", "Exact BRL amount")
  .option("--organization-reference-id <id>", "Deposit organization reference")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--plan-only", "Create and verify the deposit plan, then exit")
  .option("--validate-only", "Validate configuration without calling an API")
  .option("--with-ui", "Write a live HTML Kraken deposit dashboard")
  .action(async (options: KrakenDepositOptions, command: Command) =>
    runKrakenDeposit((await contextFor(command)).runtime(), options),
  );

const krakenFunding = kraken.command("funding").description("Run direct Kraken Funding API diagnostics");

const krakenFundingDeposit = krakenFunding
  .command("deposit")
  .description("Detect a deposit directly through the Kraken Funding API")
  .option("--asset <asset>", "Kraken fiat deposit asset")
  .option("--method-id <id>", "Kraken deposit funding method ID")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--validate-only", "Validate configuration without calling Kraken")
  .option("--with-ui", "Write a live HTML Kraken funding deposit dashboard")
  .action(async (options: KrakenOptions, command: Command) =>
    runKraken((await contextFor(command)).krakenRuntime(), options),
  );

krakenFundingDeposit
  .command("show")
  .description("Show an existing Kraken funding deposit")
  .argument("[deposit-id]", "Kraken funding deposit ID")
  .option("--account-id <id>", "Kraken Spot account ID")
  .action(async (depositId: string | undefined, options: KrakenDepositShowOptions, command: Command) => {
    await runKrakenDepositShow((await contextFor(command)).krakenRuntime(), depositId, options);
  });

kraken
  .command("swap")
  .description("Swap USD to USDC using a validated market order")
  .option("--amount <amount>", "USD amount to spend")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--with-ui", "Write a live HTML Kraken swap dashboard")
  .action(async (options: KrakenSwapOptions, command: Command) =>
    runKrakenSwap((await contextFor(command)).krakenRuntime(), options),
  );

const krakenWithdraw = kraken
  .command("withdraw")
  .description("Manage Kraken onchain targets and USDC withdrawals")
  .action(async (_options: unknown, command: Command) =>
    runKrakenWithdrawMenu((await contextFor(command)).krakenRuntime()),
  );

krakenWithdraw
  .command("register-address")
  .description("Register a new Kraken onchain target address")
  .option("--asset <asset>", "Asset", "USDC")
  .option("--account-id <id>", "Kraken Spot account ID")
  .option("--method-id <id>", "Kraken withdrawal funding method ID")
  .option("--address <address>", "Onchain target address")
  .option("--name <name>", "Target address name")
  .option("--memo <memo>", "Optional memo or tag")
  .action(async (options: KrakenRegisterAddressOptions, command: Command) =>
    runKrakenRegisterAddress((await contextFor(command)).krakenRuntime(), options),
  );

krakenWithdraw
  .command("send")
  .description("Withdraw to an existing Kraken onchain target")
  .option("--asset <asset>", "Asset", "USDC")
  .option("--account-id <id>", "Kraken Spot account ID")
  .option("--method-id <id>", "Kraken withdrawal funding method ID")
  .option("--address-id <id>", "Existing Kraken target address ID")
  .option("--amount <amount>", "Withdrawal amount")
  .addOption(new Option("--fee-mode <mode>", "Amount behavior").choices(["total", "receive"]))
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--with-ui", "Write a live HTML Kraken withdrawal dashboard")
  .action(async (options: KrakenWithdrawOptions, command: Command) =>
    runKrakenWithdraw((await contextFor(command)).krakenRuntime(), options),
  );

const openFx = program.command("openfx").description("Manage the OpenFX integration");

openFx
  .command("register")
  .description("Register OpenFX API and webhook credentials")
  .argument("[api-key-file]", "OpenFX API key JSON")
  .action(async (apiKeyFile: string | undefined, _options: unknown, command: Command) =>
    registerOpenFx((await contextFor(command)).runtime(), apiKeyFile),
  );

openFx
  .command("webhook-url")
  .description("Print the OpenFX webhook URL for this workspace")
  .action(async (_options: unknown, command: Command) => showOpenFxWebhookUrl((await contextFor(command)).runtime()));

openFx
  .command("patch-basis-theory")
  .description("Patch an existing OpenFX Basis Theory token")
  .option("--token <token>", "Basis Theory token override")
  .action(async (options: { token?: string }, command: Command) =>
    patchBasisTheory((await contextFor(command)).runtime(), options.token),
  );

openFx
  .command("delete-basis-theory")
  .description("Delete a Basis Theory token")
  .option("--token <token>", "Basis Theory token override")
  .action(async (options: { token?: string }, command: Command) =>
    deleteBasisTheory((await contextFor(command)).runtime(), options.token),
  );

openFx
  .command("create-bank-account")
  .description("Create a reusable workspace bank account")
  .option("--name <name>", "Tesser account name")
  .option("--bank-name <name>", "Bank name")
  .option("--bank-code-type <type>", "Bank code type")
  .option("--bank-identifier-code <code>", "Bank identifier code")
  .option("--bank-swift-code <code>", "Bank SWIFT code")
  .option("--account-number <number>", "Bank account number")
  .option("-y, --yes", "Skip the provider-routing confirmation")
  .action(async (options: BankAccountOptions, command: Command) =>
    createBankAccount((await contextFor(command)).runtime(), options),
  );

program.action(async (_options: GlobalOptions, command: Command) => {
  const context = await contextFor(command);
  if (!context.interaction.interactive) {
    throw new UsageError("A command is required in non-interactive mode");
  }
  await runInteractiveMenu(context);
});

async function runInteractiveMenu(context: Context): Promise<void> {
  while (true) {
    const selected = await context.interaction.choose("What do you want to do?", [
      { name: "Make an API request", value: "request" },
      { name: "Send a payment", value: "payment" },
      { name: "Run a withdrawal", value: "withdrawal" },
      { name: "Run an OpenFX rebalance", value: "rebalance" },
      { name: "Show a wallet address", value: "wallet" },
      { name: "Simulate inbound payments", value: "simulate" },
      { name: "Kraken", value: "kraken" },
      { name: "Register OpenFX credentials", value: "openfx-register" },
      { name: "Show the OpenFX webhook URL", value: "openfx-webhook" },
      {
        name: "Patch OpenFX credentials in Basis Theory",
        value: "openfx-patch",
      },
      { name: "Delete a Basis Theory token", value: "openfx-delete" },
      { name: "Create an OpenFX bank account", value: "openfx-bank" },
      { name: "Exit", value: "exit" },
    ]);
    if (selected === "exit") return;
    try {
      if (selected === "kraken") await runKrakenMenu(context.runtime());
      if (selected !== "kraken") {
        const runtime = context.runtime();
        if (selected === "request") await runRequest(runtime, undefined, undefined, {});
        if (selected === "payment") await runPayment(runtime, undefined, {});
        if (selected === "withdrawal") await runWithdrawal(runtime, {});
        if (selected === "rebalance") await runRebalance(runtime, {});
        if (selected === "wallet") await runWalletAddress(runtime, {});
        if (selected === "simulate") await runSimulateInbound(runtime, {});
        if (selected === "openfx-register") await registerOpenFx(runtime, undefined);
        if (selected === "openfx-webhook") await showOpenFxWebhookUrl(runtime);
        if (selected === "openfx-patch") await patchBasisTheory(runtime, undefined);
        if (selected === "openfx-delete") await deleteBasisTheory(runtime, undefined);
        if (selected === "openfx-bank") await createBankAccount(runtime, {});
      }
    } catch (error) {
      if (error instanceof CancelledError) context.output.info(error.message);
      else if (error instanceof Error) context.output.error(error.message);
      else context.output.error(String(error));
    }
  }
}

async function contextFor(command: Command): Promise<Context> {
  const options = command.optsWithGlobals<GlobalOptions>();
  const interaction = options.nonInteractive ? new NonInteractiveInteraction() : new TerminalInteraction();
  const output = new Output(options.output, Boolean(options.verbose));
  const envFile = options.envFile ?? (interaction.interactive ? await selectEnvironmentFile(interaction) : undefined);
  const environment = loadEnvironment(envFile);
  return {
    environment,
    interaction,
    output,
    runtime: () => createRuntime(environment, interaction, output),
    krakenRuntime: () => ({ environment, interaction, output }),
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function numberOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new InvalidArgumentError("must be greater than zero");
  return parsed;
}

function integerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("must be a positive integer");
  return parsed;
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.code !== "commander.helpDisplayed" && error.code !== "commander.version") {
      process.exitCode = error.exitCode;
    }
  } else if (error instanceof PlaygroundError) {
    new Output("human", false).error(error.message);
    process.exitCode = error.exitCode;
  } else if (error instanceof Error && error.name === "ExitPromptError") {
    process.stderr.write("Cancelled\n");
    process.exitCode = 130;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    new Output("human", false).error(message);
    process.exitCode = 1;
  }
}
