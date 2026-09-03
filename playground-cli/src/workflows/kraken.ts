import {
  firstValue,
  getKrakenConfiguration,
  positiveNumber,
  type Environment,
} from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import {
  KrakenFundingClient,
  type KrakenFundingApi,
} from "../kraken.ts";
import type { Interaction } from "../interaction.ts";
import { sanitize, type Output } from "../output.ts";

type KrakenAsset = {
  class?: string;
  name?: string;
};

type KrakenFundingMethod = {
  asset?: KrakenAsset;
  method_id?: string;
  method_name?: string;
  minimum_amount?: string;
  network?: {
    network_id?: string;
    network_name?: string;
  } | null;
  deposit?: Record<string, unknown>;
  [key: string]: unknown;
};

type KrakenDeposit = {
  deposit_id?: string;
  method_id?: string;
  network_id?: string;
  status?: string;
  amount?: unknown;
  fee?: unknown;
  create_time?: string;
  [key: string]: unknown;
};

export type KrakenOptions = {
  asset?: string;
  accountId?: string;
  methodId?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  validateOnly?: boolean;
};

export type KrakenEnvironment = {
  asset: string;
  accountId?: string;
  methodId?: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
};

export type KrakenRuntime = {
  environment: Environment;
  interaction: Interaction;
  output: Output;
};

export async function runKraken(
  runtime: KrakenRuntime,
  options: KrakenOptions,
  fundingApi?: KrakenFundingApi,
): Promise<void> {
  const environment = resolveKrakenEnvironment(runtime.environment, options);
  const configuration = getKrakenConfiguration(runtime.environment);
  if (runtime.interaction.interactive && !options.validateOnly) {
    await configureKrakenEnvironment(runtime, environment);
  }
  runtime.output.progress("kraken.environment.validated", {
    baseUrl: configuration.baseUrl,
    asset: environment.asset,
    accountId: environment.accountId ?? "Default Kraken Spot account",
    methodId: environment.methodId ?? "Interactive selection",
    pollIntervalSeconds: environment.pollIntervalSeconds,
    timeoutSeconds: environment.timeoutSeconds,
  });
  if (options.validateOnly) {
    runtime.output.result({ valid: true });
    return;
  }
  const client = fundingApi ?? new KrakenFundingClient(configuration, runtime.output);
  const methodsResponse = await client.request("GET", "/funding/v1/methods/deposit", {
    query: {
      asset: { class: "currency", name: environment.asset },
      account_id: environment.accountId,
      limit: 500,
    },
    operation: "List Kraken deposit funding methods",
  });
  const methods = requireArray<KrakenFundingMethod>(
    methodsResponse.methods,
    "Kraken funding-method response did not contain methods",
  ).filter((method) => method.asset?.name?.toUpperCase() === environment.asset);
  if (!methods.length) {
    showCompleteRecord(runtime, "kraken.deposit-methods.unavailable", methodsResponse);
    throw new UsageError(`Kraken returned no ${environment.asset} deposit funding methods`);
  }
  const selectedMethod = await selectFundingMethod(
    runtime,
    methods,
    environment.asset,
    environment.methodId,
  );
  const methodId = requireText(selectedMethod.method_id, "Selected Kraken method has no method_id");
  const probeStartedAt = new Date().toISOString();
  runtime.output.progress("kraken.deposit-method.selected", {
    methodId,
    methodName: selectedMethod.method_name,
    minimumAmount: selectedMethod.minimum_amount,
    networkId: selectedMethod.network?.network_id,
    networkName: selectedMethod.network?.network_name,
  });
  const baselineResponse = await listDeposits(client, environment, methodId);
  const baselineDeposits = depositsFrom(baselineResponse);
  const baselineDepositIds = new Set(
    baselineDeposits
      .map((deposit) => deposit.deposit_id)
      .filter((depositId): depositId is string => Boolean(depositId)),
  );
  runtime.output.progress("kraken.deposit-baseline.recorded", {
    methodId,
    probeStartedAt,
    depositCount: baselineDeposits.length,
  });
  if (selectedMethod.method_name === "Pix (PayAmigo)") {
    runtime.output.info(
      [
        "Complete the BRL deposit using Pix (PayAmigo) in Kraken Web:",
        "https://www.kraken.com/c",
        "Generate the PIX code there and complete the transfer before continuing.",
      ].join("\n"),
    );
    await waitForManualPixDeposit(runtime);
  } else {
    await runtime.interaction.approve("Claim Kraken deposit instructions?");
    let claimResponse: Record<string, unknown>;
    try {
      claimResponse = await client.request("PUT", "/funding/v1/deposit/address", {
        query: { account_id: environment.accountId },
        body: { method_id: methodId },
        operation: "Claim Kraken deposit instructions",
      });
    } catch (error) {
      if (error instanceof ApiError) {
        showCompleteRecord(runtime, "kraken.deposit-instructions.unavailable", {
          status: error.status,
          response: error.body,
        });
      }
      throw error;
    }
    showCompleteRecord(runtime, "kraken.deposit-instructions.claimed", claimResponse);
    if (!isRecord(claimResponse.address_details) || !isRecord(claimResponse.address_details.fiat)) {
      throw new UsageError("Kraken did not return fiat deposit instructions for the selected BRL method");
    }
    await runtime.interaction.approve("Start polling Kraken after sending the deposit?");
  }
  const deposit = await waitForSuccessfulDeposit(
    runtime,
    client,
    environment,
    methodId,
    probeStartedAt,
    baselineDepositIds,
  );
  if (!runtime.output.verbose) runtime.output.result(deposit);
}

async function waitForManualPixDeposit(runtime: KrakenRuntime): Promise<void> {
  if (!runtime.interaction.interactive) {
    throw new UsageError("Pix (PayAmigo) requires an interactive Kraken Web deposit before polling");
  }
  while (
    !(await runtime.interaction.confirm(
      "Have you completed the PIX deposit in Kraken Web and are you ready to start polling?",
      false,
    ))
  ) {}
}

export async function configureKrakenEnvironment(
  runtime: KrakenRuntime,
  environment: KrakenEnvironment,
): Promise<void> {
  type Field = "continue" | "asset" | "accountId" | "methodId" | "pollInterval" | "timeout";
  while (true) {
    const field = await runtime.interaction.choose<Field>("Review Kraken prototype values", [
      { name: "Use these values", value: "continue" },
      { name: `Asset: ${environment.asset}`, value: "asset" },
      {
        name: `Account ID: ${environment.accountId ?? "Default Kraken Spot account"}`,
        value: "accountId",
      },
      {
        name: `Method ID: ${environment.methodId ?? "Interactive selection"}`,
        value: "methodId",
      },
      {
        name: `Poll interval: ${environment.pollIntervalSeconds} seconds`,
        value: "pollInterval",
      },
      { name: `Timeout: ${environment.timeoutSeconds} seconds`, value: "timeout" },
    ]);
    if (field === "continue") return;
    if (field === "asset") {
      environment.asset = (
        await runtime.interaction.text("Kraken deposit asset", undefined, environment.asset)
      ).toUpperCase();
    }
    if (field === "accountId") {
      environment.accountId = await runtime.interaction.optionalText(
        "Kraken account ID (empty uses the default Spot account)",
        environment.accountId,
      );
    }
    if (field === "methodId") {
      environment.methodId = await runtime.interaction.optionalText(
        "Kraken funding method ID (empty selects interactively)",
        environment.methodId,
      );
    }
    if (field === "pollInterval") {
      environment.pollIntervalSeconds = await promptPositiveNumber(
        runtime,
        "Poll interval in seconds",
        environment.pollIntervalSeconds,
      );
    }
    if (field === "timeout") {
      environment.timeoutSeconds = await promptPositiveNumber(
        runtime,
        "Timeout in seconds",
        environment.timeoutSeconds,
      );
    }
  }
}

export function resolveKrakenEnvironment(
  environment: Environment,
  options: KrakenOptions,
): KrakenEnvironment {
  return {
    asset: (
      options.asset ?? firstValue(environment, "KRAKEN_DEPOSIT_ASSET") ?? "BRL"
    ).toUpperCase(),
    accountId: options.accountId ?? firstValue(environment, "KRAKEN_ACCOUNT_ID"),
    methodId: options.methodId ?? firstValue(environment, "KRAKEN_DEPOSIT_METHOD_ID"),
    pollIntervalSeconds: positiveNumber(
      options.pollIntervalSeconds ?? firstValue(environment, "KRAKEN_POLL_INTERVAL_SECONDS"),
      "KRAKEN_POLL_INTERVAL_SECONDS",
      3,
    ),
    timeoutSeconds: positiveNumber(
      options.timeoutSeconds ?? firstValue(environment, "KRAKEN_TIMEOUT_SECONDS"),
      "KRAKEN_TIMEOUT_SECONDS",
      1800,
    ),
  };
}

async function selectFundingMethod(
  runtime: KrakenRuntime,
  methods: KrakenFundingMethod[],
  asset: string,
  configuredMethodId: string | undefined,
): Promise<KrakenFundingMethod> {
  if (configuredMethodId) {
    const configured = methods.find((method) => method.method_id === configuredMethodId);
    if (!configured) {
      throw new UsageError(`Kraken method ${configuredMethodId} is not available for this asset`);
    }
    return configured;
  }
  const selectedMethodId = await runtime.interaction.choose(
    `Select the Kraken ${asset} deposit method`,
    methods.map((method) => ({
      name: [
        method.method_name ?? "Unnamed method",
        method.network?.network_name,
        method.minimum_amount ? `minimum ${method.minimum_amount}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
      value: requireText(method.method_id, "Kraken funding method has no method_id"),
    })),
  );
  return methods.find((method) => method.method_id === selectedMethodId)!;
}

async function listDeposits(
  client: KrakenFundingApi,
  environment: KrakenEnvironment,
  methodId: string,
  startTime?: string,
): Promise<Record<string, unknown>> {
  return client.request("GET", "/funding/v1/deposits", {
    query: {
      account_id: environment.accountId,
      scope: { method_id: methodId },
      start_time: startTime,
      limit: 500,
    },
    operation: "List Kraken funding deposits",
  });
}

async function waitForSuccessfulDeposit(
  runtime: KrakenRuntime,
  client: KrakenFundingApi,
  environment: KrakenEnvironment,
  methodId: string,
  probeStartedAt: string,
  baselineDepositIds: Set<string>,
): Promise<KrakenDeposit> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  let lastDeposit: KrakenDeposit | undefined;
  while (Date.now() < deadline) {
    const response = await listDeposits(client, environment, methodId, probeStartedAt);
    const newDeposits = depositsFrom(response).filter(
      (deposit) =>
        deposit.method_id === methodId &&
        Boolean(deposit.deposit_id) &&
        !baselineDepositIds.has(deposit.deposit_id!),
    );
    if (newDeposits.length > 1) {
      showCompleteRecord(runtime, "kraken.deposit-detection.ambiguous", { deposits: newDeposits });
      throw new UsageError("More than one new Kraken deposit matched this prototype run");
    }
    const deposit = newDeposits[0];
    if (deposit) {
      lastDeposit = deposit;
      const state = `${deposit.deposit_id}:${deposit.status}`;
      const successful = deposit.status?.toLowerCase() === "success";
      if (state !== previousState && !successful && !runtime.output.verbose) {
        runtime.output.progress("kraken.deposit.detected", {
          depositId: deposit.deposit_id,
          methodId: deposit.method_id,
          networkId: deposit.network_id,
          status: deposit.status,
          amount: deposit.amount,
          fee: deposit.fee,
          createTime: deposit.create_time,
        });
      }
      previousState = state;
      if (successful) return deposit;
    }
    await Bun.sleep(environment.pollIntervalSeconds * 1000);
  }
  if (lastDeposit) {
    showCompleteRecord(runtime, "kraken.deposit.timeout", { deposit: lastDeposit });
  }
  throw new UsageError("Timed out waiting for a successful Kraken deposit");
}

function depositsFrom(response: Record<string, unknown>): KrakenDeposit[] {
  if (Object.keys(response).length === 0) return [];
  return requireArray<KrakenDeposit>(
    response.deposits,
    "Kraken funding-deposit response did not contain deposits",
  );
}

function showCompleteRecord(
  runtime: KrakenRuntime,
  event: string,
  value: Record<string, unknown>,
): void {
  runtime.output.info(JSON.stringify(sanitize({ event, ...value }), null, 2));
}

function requireArray<T>(value: unknown, message: string): T[] {
  if (!Array.isArray(value)) throw new UsageError(message);
  return value as T[];
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function promptPositiveNumber(
  runtime: KrakenRuntime,
  label: string,
  defaultValue: number,
): Promise<number> {
  while (true) {
    const value = await runtime.interaction.text(label, undefined, String(defaultValue));
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    runtime.output.error(`${label} must be greater than zero`);
  }
}
