import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { NonInteractiveInteraction, TerminalInteraction, type Interaction } from "./interaction.ts";
import {
  krakenEnvironmentVariables,
  loadEnvironment,
  requireEnvironmentVariables,
  signingEnvironmentVariables,
  tesserEnvironmentVariables,
  type Environment,
} from "./config.ts";
import { PlaygroundError, UsageError } from "./errors.ts";
import { selectEnvironmentFile } from "./environment-selection.ts";
import { Output } from "./output.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import { registerTempoCommands, registerTempoExperimentCommands, runTempoMenu } from "./tempo/commands.ts";
import { runRequest, type RequestCommandOptions } from "./workflows/request.ts";
import { runAdminInvite } from "./workflows/admin-invite.ts";
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
import {
  runKrakenCliOnlyDeposit,
  type KrakenCliOnlyDepositOptions,
} from "./workflows/kraken-cli-only-deposit.ts";
import { runKrakenDepositShow, type KrakenDepositShowOptions } from "./workflows/kraken-deposit.ts";
import { runKrakenCliOnlyMenu, runKrakenMenu } from "./workflows/kraken-menu.ts";
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
  runtime(operation: string, additionalVariables?: readonly string[]): Runtime;
  krakenRuntime(operation: string): KrakenRuntime;
};

const program = new Command()
  .name("tesser-playground")
  .description("Interactive and scriptable playground for Tesser and provider experiments")
  .option("--env-file <path>", "Load configuration from this file")
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
      runRequest((await contextFor(command)).runtime("API request"), method, path, options),
  );

const admin = program
  .command("admin", { hidden: true })
  .description("Manage Tesser users and administrative operations");

admin
  .command("invite")
  .description("Create a user and send a password-setup email")
  .argument("[email]", "Email address to invite")
  .action(
    async (
      email: string | undefined,
      _options: unknown,
      command: Command,
    ) => runAdminInvite(await contextFor(command), email),
  );

const payment = program
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
    runPayment(
      (await contextFor(command)).runtime("Payment", options.paymentId ? [] : signingEnvironmentVariables),
      destinationWalletAddress,
      options,
    ),
  );

program
  .command("withdrawal", { hidden: true })
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
    runWithdrawal((await contextFor(command)).runtime("Treasury: withdrawal", signingEnvironmentVariables), options),
  );

program
  .command("rebalance", { hidden: true })
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
    runRebalance((await contextFor(command)).runtime("Treasury: rebalance", signingEnvironmentVariables), options),
  );

program
  .command("wallet-address", { hidden: true })
  .description("Resolve a workspace wallet address")
  .option("--wallet-id <id>", "Wallet account ID")
  .option("--currency <currency>", "Wallet asset currency")
  .option("--network <network>", "Wallet asset network")
  .action(async (options: WalletOptions, command: Command) =>
    runWalletAddress((await contextFor(command)).runtime("Accounts: wallet address"), options),
  );

program
  .command("simulate-inbound", { hidden: true })
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
      runSimulateInbound((await contextFor(command)).runtime("Payment: simulate inbound"), {
        ...options,
        walletId: options.walletId ?? options.toAccount,
        mockedRiskStatus: options.riskStatus ?? options.mockedRiskStatus,
      }),
  );

const kraken = program
  .command("kraken", { hidden: true })
  .description("Manage Kraken balances, deposits, swaps, and withdrawals")
  .action(async (_options: unknown, command: Command) => runKrakenMenu(await contextFor(command)));

kraken
  .command("register_secrets")
  .description("Register Kraken credentials and CAD instructions with Tesser")
  .option("--cad-instructions-file <path>", "Normalized Kraken CAD deposit instructions JSON")
  .action(async (options: KrakenRegisterSecretsOptions, command: Command) =>
    runKrakenRegisterSecrets(
      (await contextFor(command)).runtime("Workspace: register Kraken secrets", krakenEnvironmentVariables),
      options,
    ),
  );

kraken
  .command("balances")
  .description("Show Kraken extended balances")
  .action(async (_options: unknown, command: Command) => {
    await runKrakenBalances((await contextFor(command)).krakenRuntime("Provider experiments: Kraken balances"));
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
    runKrakenDeposit((await contextFor(command)).runtime("Treasury: deposit"), options),
  );

const krakenCliOnly = kraken
  .command("cli-only")
  .description("Run Kraken flows owned entirely by the playground CLI")
  .action(async (_options: unknown, command: Command) =>
    runKrakenCliOnlyMenu(await contextFor(command)),
  );

krakenCliOnly
  .command("deposit")
  .description("Run a CLI-only BRL-to-USDC deposit through Kraken")
  .option("--amount <amount>", "Exact BRL deposit amount")
  .option("--resume-usd-amount <amount>", "Resume after a completed BRL-to-USD order")
  .option("--destination-address <address>", "Destination EVM wallet address")
  .option("--network <network>", "Destination mainnet: ETHEREUM or BASE")
  .option("--deposit-method-id <id>", "Kraken BRL deposit method ID")
  .option("--kraken-deposit-id <id>", "Reuse a successful Kraken BRL deposit")
  .option("--withdrawal-method-id <id>", "Kraken native USDC withdrawal method ID")
  .option("--account-id <id>", "Kraken account ID")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--validate-only", "Validate configuration without calling an API")
  .option("--with-ui", "Write a live HTML CLI-only deposit dashboard")
  .action(async (options: KrakenCliOnlyDepositOptions, command: Command) =>
    runKrakenCliOnlyDeposit(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken BRL-to-USDC flow"),
      options,
    ),
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
  .action(async (options: KrakenOptions, command: Command) => {
    await runKraken((await contextFor(command)).krakenRuntime("Provider experiments: Kraken deposit"), options);
  });

krakenFundingDeposit
  .command("show")
  .description("Show an existing Kraken funding deposit")
  .argument("[deposit-id]", "Kraken funding deposit ID")
  .option("--account-id <id>", "Kraken Spot account ID")
  .action(async (depositId: string | undefined, options: KrakenDepositShowOptions, command: Command) => {
    await runKrakenDepositShow(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken deposit"),
      depositId,
      options,
    );
  });

kraken
  .command("swap")
  .description("Swap BRL or USD to USDC using validated market orders")
  .option("--amount <amount>", "Source-currency amount to spend")
  .option("--from-currency <currency>", "Source currency: BRL or USD")
  .option("--to-currency <currency>", "Destination currency: USDC")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--with-ui", "Write a live HTML Kraken swap dashboard")
  .action(async (options: KrakenSwapOptions, command: Command) =>
    runKrakenSwap((await contextFor(command)).krakenRuntime("Provider experiments: Kraken swap"), options),
  );

const krakenWithdraw = kraken
  .command("withdraw")
  .description("Manage Kraken onchain targets and USDC withdrawals")
  .action(async (_options: unknown, command: Command) =>
    runKrakenWithdrawMenu(await contextFor(command)),
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
    runKrakenRegisterAddress(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken register withdrawal address"),
      options,
    ),
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
    runKrakenWithdraw(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken withdrawal"),
      options,
    ),
  );

const openFx = program.command("openfx", { hidden: true }).description("Manage the OpenFX integration");

openFx
  .command("register")
  .description("Register OpenFX API and webhook credentials")
  .argument("[api-key-file]", "OpenFX API key JSON")
  .action(async (apiKeyFile: string | undefined, _options: unknown, command: Command) =>
    registerOpenFx(
      (await contextFor(command)).runtime("Workspace: register OpenFX secrets", ["OPENFX_WEBHOOK_SIGNING_KEY"]),
      apiKeyFile,
    ),
  );

openFx
  .command("webhook-url")
  .description("Print the OpenFX webhook URL for this workspace")
  .action(async (_options: unknown, command: Command) =>
    showOpenFxWebhookUrl((await contextFor(command)).runtime("Workspace: OpenFX webhook URL")),
  );

openFx
  .command("patch-basis-theory")
  .description("Patch an existing OpenFX Basis Theory token")
  .option("--token <token>", "Basis Theory token override")
  .action(async (options: { token?: string }, command: Command) =>
    patchBasisTheory(await contextFor(command), options.token),
  );

openFx
  .command("delete-basis-theory")
  .description("Delete a Basis Theory token")
  .option("--token <token>", "Basis Theory token override")
  .action(async (options: { token?: string }, command: Command) =>
    deleteBasisTheory(await contextFor(command), options.token),
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
    createBankAccount((await contextFor(command)).runtime("Accounts: create bank account"), options),
  );

payment
  .command("create")
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
    runPayment(
      (await contextFor(command)).runtime("Payment", options.paymentId ? [] : signingEnvironmentVariables),
      destinationWalletAddress,
      options,
    ),
  );

payment
  .command("simulate-inbound")
  .description("Create one or more simulated inbound sandbox payments")
  .option("--wallet-id <id>", "Destination wallet ID")
  .option("--network <network>", "Sandbox network")
  .option("--mocked-risk-status <status>", "Mocked risk status", "automatically_approved")
  .option("--count <count>", "Number of simulations", integerOption, 1)
  .option("-y, --yes", "Skip the batch confirmation")
  .action(async (options: SimulateInboundOptions, command: Command) =>
    runSimulateInbound((await contextFor(command)).runtime("Payment: simulate inbound"), options),
  );

const treasury = program.command("treasury").description("Manage first-party funds movements");

treasury
  .command("deposit")
  .description("Create or resume a Tesser deposit into Kraken")
  .option("--deposit-id <id>", "Resume an existing Tesser deposit")
  .option("--source-bank-id <id>", "Workspace source bank account ID")
  .option("--kraken-ledger-id <id>", "Managed Kraken ledger account ID")
  .option("--amount <amount>", "Exact BRL amount")
  .option("--organization-reference-id <id>", "Deposit organization reference")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--plan-only", "Create and verify the deposit plan, then exit")
  .option("--validate-only", "Validate configuration without calling an API")
  .option("--with-ui", "Write a live HTML deposit dashboard")
  .action(async (options: KrakenDepositOptions, command: Command) =>
    runKrakenDeposit((await contextFor(command)).runtime("Treasury: deposit"), options),
  );

treasury
  .command("withdrawal")
  .description("Create or resume and sign a withdrawal")
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
    runWithdrawal((await contextFor(command)).runtime("Treasury: withdrawal", signingEnvironmentVariables), options),
  );

treasury
  .command("rebalance")
  .description("Create or resume and sign a rebalance")
  .option("--rebalance-id <id>", "Resume an existing rebalance")
  .option("--source-wallet-id <id>", "Source wallet account ID")
  .option("--destination-ledger-id <id>", "Destination ledger account ID")
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
    runRebalance((await contextFor(command)).runtime("Treasury: rebalance", signingEnvironmentVariables), options),
  );

const accounts = program.command("accounts").description("Manage Tesser accounts");

accounts
  .command("wallet-address")
  .description("Resolve a workspace wallet address")
  .option("--wallet-id <id>", "Wallet account ID")
  .option("--currency <currency>", "Wallet asset currency")
  .option("--network <network>", "Wallet asset network")
  .action(async (options: WalletOptions, command: Command) =>
    runWalletAddress((await contextFor(command)).runtime("Accounts: wallet address"), options),
  );

accounts
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
    createBankAccount((await contextFor(command)).runtime("Accounts: create bank account"), options),
  );

const workspace = program.command("workspace").description("Manage workspace configuration and users");

workspace
  .command("invite")
  .description("Create a user and send a password-setup email")
  .argument("[email]", "Email address to invite")
  .action(async (email: string | undefined, _options: unknown, command: Command) =>
    runAdminInvite(await contextFor(command), email),
  );

workspace
  .command("openfx-webhook-url")
  .description("Print the OpenFX webhook URL for this workspace")
  .action(async (_options: unknown, command: Command) =>
    showOpenFxWebhookUrl((await contextFor(command)).runtime("Workspace: OpenFX webhook URL")),
  );

const registerSecrets = workspace.command("register-secrets").description("Register provider secrets");

registerSecrets
  .command("kraken")
  .description("Register Kraken credentials and CAD instructions")
  .option("--cad-instructions-file <path>", "Normalized Kraken CAD deposit instructions JSON")
  .action(async (options: KrakenRegisterSecretsOptions, command: Command) =>
    runKrakenRegisterSecrets(
      (await contextFor(command)).runtime("Workspace: register Kraken secrets", krakenEnvironmentVariables),
      options,
    ),
  );

registerSecrets
  .command("openfx")
  .description("Register OpenFX API and webhook credentials")
  .argument("[api-key-file]", "OpenFX API key JSON")
  .action(async (apiKeyFile: string | undefined, _options: unknown, command: Command) =>
    registerOpenFx(
      (await contextFor(command)).runtime("Workspace: register OpenFX secrets", ["OPENFX_WEBHOOK_SIGNING_KEY"]),
      apiKeyFile,
    ),
  );

const providerExperiments = program
  .command("provider-experiments")
  .description("Run direct provider operations outside the Tesser API");

const providerKraken = providerExperiments.command("kraken").description("Run direct Kraken operations");

providerKraken
  .command("balances")
  .description("Show Kraken extended balances")
  .action(async (_options: unknown, command: Command) => {
    await runKrakenBalances((await contextFor(command)).krakenRuntime("Provider experiments: Kraken balances"));
  });

const providerKrakenDeposit = providerKraken
  .command("deposit")
  .description("Detect a deposit through the Kraken Funding API")
  .option("--asset <asset>", "Kraken fiat deposit asset")
  .option("--method-id <id>", "Kraken deposit funding method ID")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--validate-only", "Validate configuration without calling Kraken")
  .option("--with-ui", "Write a live HTML Kraken funding deposit dashboard")
  .action(async (options: KrakenOptions, command: Command) => {
    await runKraken((await contextFor(command)).krakenRuntime("Provider experiments: Kraken deposit"), options);
  });

providerKrakenDeposit
  .command("show")
  .description("Show an existing Kraken funding deposit")
  .argument("[deposit-id]", "Kraken funding deposit ID")
  .option("--account-id <id>", "Kraken Spot account ID")
  .action(async (depositId: string | undefined, options: KrakenDepositShowOptions, command: Command) => {
    await runKrakenDepositShow(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken deposit"),
      depositId,
      options,
    );
  });

providerKraken
  .command("swap")
  .description("Swap BRL or USD to USDC")
  .option("--amount <amount>", "Source-currency amount to spend")
  .option("--from-currency <currency>", "Source currency: BRL or USD")
  .option("--to-currency <currency>", "Destination currency: USDC")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--with-ui", "Write a live HTML Kraken swap dashboard")
  .action(async (options: KrakenSwapOptions, command: Command) =>
    runKrakenSwap((await contextFor(command)).krakenRuntime("Provider experiments: Kraken swap"), options),
  );

providerKraken
  .command("register-withdrawal-address")
  .description("Register a new Kraken onchain target address")
  .option("--asset <asset>", "Asset", "USDC")
  .option("--account-id <id>", "Kraken Spot account ID")
  .option("--method-id <id>", "Kraken withdrawal funding method ID")
  .option("--address <address>", "Onchain target address")
  .option("--name <name>", "Target address name")
  .option("--memo <memo>", "Optional memo or tag")
  .action(async (options: KrakenRegisterAddressOptions, command: Command) =>
    runKrakenRegisterAddress(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken register withdrawal address"),
      options,
    ),
  );

providerKraken
  .command("withdraw")
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
    runKrakenWithdraw(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken withdrawal"),
      options,
    ),
  );

providerKraken
  .command("brl-to-usdc")
  .description("Run a direct BRL-to-USDC flow through Kraken")
  .option("--amount <amount>", "Exact BRL deposit amount")
  .option("--resume-usd-amount <amount>", "Resume after a completed BRL-to-USD order")
  .option("--destination-address <address>", "Destination EVM wallet address")
  .option("--network <network>", "Destination mainnet: ETHEREUM or BASE")
  .option("--deposit-method-id <id>", "Kraken BRL deposit method ID")
  .option("--kraken-deposit-id <id>", "Reuse a successful Kraken BRL deposit")
  .option("--withdrawal-method-id <id>", "Kraken native USDC withdrawal method ID")
  .option("--account-id <id>", "Kraken account ID")
  .option("--poll-interval-seconds <seconds>", "Polling interval", numberOption)
  .option("--timeout-seconds <seconds>", "Workflow timeout", numberOption)
  .option("--validate-only", "Validate configuration without calling an API")
  .option("--with-ui", "Write a live HTML CLI-only deposit dashboard")
  .action(async (options: KrakenCliOnlyDepositOptions, command: Command) =>
    runKrakenCliOnlyDeposit(
      (await contextFor(command)).krakenRuntime("Provider experiments: Kraken BRL-to-USDC flow"),
      options,
    ),
  );

const providerBasisTheory = providerExperiments
  .command("basis-theory")
  .description("Run direct Basis Theory operations");

providerBasisTheory
  .command("patch-openfx-token")
  .description("Patch an existing OpenFX Basis Theory token")
  .option("--token <token>", "Basis Theory token override")
  .action(async (options: { token?: string }, command: Command) =>
    patchBasisTheory(await contextFor(command), options.token),
  );

providerBasisTheory
  .command("delete-token")
  .description("Delete a Basis Theory token")
  .option("--token <token>", "Basis Theory token override")
  .action(async (options: { token?: string }, command: Command) =>
    deleteBasisTheory(await contextFor(command), options.token),
  );

registerTempoExperimentCommands(providerExperiments, contextFor);

registerTempoCommands(program, contextFor);

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
      { name: "Payment", value: "payment" },
      { name: "Treasury", value: "treasury" },
      { name: "Accounts", value: "accounts" },
      { name: "Workspace", value: "workspace" },
      { name: "Provider experiments", value: "providers" },
      { name: "API request", value: "request" },
      { name: "Exit", value: "exit" },
    ] as const);
    if (selected === "exit") return;
    if (selected === "request") {
      await runRequest(context.runtime("API request"), undefined, undefined, {});
      return;
    }
    const completed =
      selected === "payment"
        ? await runPaymentMenu(context)
        : selected === "treasury"
          ? await runTreasuryMenu(context)
          : selected === "accounts"
            ? await runAccountsMenu(context)
            : selected === "workspace"
              ? await runWorkspaceMenu(context)
              : await runProviderExperimentsMenu(context);
    if (completed) return;
  }
}

async function runPaymentMenu(context: Context): Promise<boolean> {
  const selected = await context.interaction.choose("Payment", [
    { name: "Create or resume payment", value: "payment" },
    { name: "Simulate inbound payment", value: "simulate" },
    { name: "Back", value: "back" },
  ] as const);
  if (selected === "back") return false;
  if (selected === "payment") {
    await runPayment(context.runtime("Payment", signingEnvironmentVariables), undefined, {});
  } else {
    await runSimulateInbound(context.runtime("Payment: simulate inbound"), {});
  }
  return true;
}

async function runTreasuryMenu(context: Context): Promise<boolean> {
  const selected = await context.interaction.choose("Treasury", [
    { name: "Deposit", value: "deposit" },
    { name: "Withdrawal", value: "withdrawal" },
    { name: "Rebalance", value: "rebalance" },
    { name: "Back", value: "back" },
  ] as const);
  if (selected === "back") return false;
  if (selected === "deposit") {
    await runKrakenDeposit(context.runtime("Treasury: deposit"), {});
  }
  if (selected === "withdrawal") {
    await runWithdrawal(context.runtime("Treasury: withdrawal", signingEnvironmentVariables), {});
  }
  if (selected === "rebalance") {
    await runRebalance(context.runtime("Treasury: rebalance", signingEnvironmentVariables), {});
  }
  return true;
}

async function runAccountsMenu(context: Context): Promise<boolean> {
  const selected = await context.interaction.choose("Accounts", [
    { name: "Wallet address", value: "wallet" },
    { name: "Create bank account", value: "bank" },
    { name: "Back", value: "back" },
  ] as const);
  if (selected === "back") return false;
  if (selected === "wallet") {
    await runWalletAddress(context.runtime("Accounts: wallet address"), {});
  } else {
    await createBankAccount(context.runtime("Accounts: create bank account"), {});
  }
  return true;
}

async function runWorkspaceMenu(context: Context): Promise<boolean> {
  while (true) {
    const selected = await context.interaction.choose("Workspace", [
      { name: "Invite user", value: "invite" },
      { name: "Register secrets", value: "secrets" },
      { name: "OpenFX webhook URL", value: "webhook" },
      { name: "Back", value: "back" },
    ] as const);
    if (selected === "back") return false;
    if (selected === "invite") {
      await runAdminInvite(context, undefined);
      return true;
    }
    if (selected === "webhook") {
      await showOpenFxWebhookUrl(context.runtime("Workspace: OpenFX webhook URL"));
      return true;
    }
    const provider = await context.interaction.choose("Register secrets", [
      { name: "Kraken", value: "kraken" },
      { name: "OpenFX", value: "openfx" },
      { name: "Back", value: "back" },
    ] as const);
    if (provider === "back") continue;
    if (provider === "kraken") {
      await runKrakenRegisterSecrets(
        context.runtime("Workspace: register Kraken secrets", krakenEnvironmentVariables),
        {},
      );
    } else {
      await registerOpenFx(
        context.runtime("Workspace: register OpenFX secrets", ["OPENFX_WEBHOOK_SIGNING_KEY"]),
        undefined,
      );
    }
    return true;
  }
}

async function runProviderExperimentsMenu(context: Context): Promise<boolean> {
  while (true) {
    const selected = await context.interaction.choose("Provider experiments", [
      { name: "Kraken", value: "kraken" },
      { name: "Tempo", value: "tempo" },
      { name: "Basis Theory", value: "basis-theory" },
      { name: "Back", value: "back" },
    ] as const);
    if (selected === "back") return false;
    if (selected === "kraken") {
      const completed = await runProviderKrakenMenu(context);
      if (completed) return true;
    }
    if (selected === "tempo") {
      const completed = await runTempoMenu(context);
      if (completed) return true;
    }
    if (selected === "basis-theory") {
      const completed = await runBasisTheoryMenu(context);
      if (completed) return true;
    }
  }
}

async function runProviderKrakenMenu(context: Context): Promise<boolean> {
  const selected = await context.interaction.choose("Provider experiments: Kraken", [
    { name: "Balances", value: "balances" },
    { name: "Deposit", value: "deposit" },
    { name: "Show deposit", value: "show-deposit" },
    { name: "Swap", value: "swap" },
    { name: "Register withdrawal address", value: "register-address" },
    { name: "Withdraw", value: "withdraw" },
    { name: "BRL-to-USDC flow", value: "brl-usdc" },
    { name: "Back", value: "back" },
  ] as const);
  if (selected === "back") return false;
  const runtime = context.krakenRuntime(`Provider experiments: Kraken ${selected}`);
  if (selected === "balances") await runKrakenBalances(runtime);
  if (selected === "deposit") await runKraken(runtime, {});
  if (selected === "show-deposit") await runKrakenDepositShow(runtime, undefined, {});
  if (selected === "swap") await runKrakenSwap(runtime);
  if (selected === "register-address") await runKrakenRegisterAddress(runtime);
  if (selected === "withdraw") await runKrakenWithdraw(runtime);
  if (selected === "brl-usdc") await runKrakenCliOnlyDeposit(runtime, {});
  return true;
}

async function runBasisTheoryMenu(context: Context): Promise<boolean> {
  const selected = await context.interaction.choose("Provider experiments: Basis Theory", [
    { name: "Patch OpenFX token", value: "patch" },
    { name: "Delete token", value: "delete" },
    { name: "Back", value: "back" },
  ] as const);
  if (selected === "back") return false;
  if (selected === "patch") await patchBasisTheory(context, undefined);
  else await deleteBasisTheory(context, undefined);
  return true;
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
    runtime: (operation, additionalVariables = []) => {
      requireEnvironmentVariables(environment, operation, [
        ...tesserEnvironmentVariables,
        ...additionalVariables,
      ]);
      return createRuntime(environment, interaction, output);
    },
    krakenRuntime: (operation) => {
      requireEnvironmentVariables(environment, operation, krakenEnvironmentVariables);
      return { environment, interaction, output };
    },
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
