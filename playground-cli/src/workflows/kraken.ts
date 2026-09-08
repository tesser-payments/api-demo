import { getKrakenConfiguration, positiveNumber, type Environment } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { KrakenFundingClient, type KrakenFundingApi } from "../kraken.ts";
import type { Interaction } from "../interaction.ts";
import { KrakenDashboard, resolveKrakenUi } from "../kraken-dashboard.ts";
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
  deposit?: {
    address_generation?: {
      status?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export type KrakenDeposit = {
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
  methodId?: string;
  pollIntervalSeconds?: number;
  timeoutSeconds?: number;
  validateOnly?: boolean;
  withUi?: boolean;
  embedded?: boolean;
  allowExistingDeposit?: boolean;
  existingDepositId?: string;
  expectedAmount?: string;
};

export type KrakenEnvironment = {
  asset: string;
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
): Promise<KrakenDeposit | undefined> {
  const environment = resolveKrakenEnvironment(runtime.environment, options);
  const configuration = getKrakenConfiguration(runtime.environment);
  const withUi = options.embedded
    ? false
    : await resolveKrakenUi(runtime.interaction, options.withUi, "funding-deposit", options.validateOnly);
  const dashboard = withUi ? new KrakenDashboard("funding-deposit") : undefined;
  dashboard?.start();
  if (dashboard) runtime.output.info(`Kraken funding deposit UI: ${dashboard.outputPath}`);
  try {
    dashboard?.update("configure", "Reviewing the Kraken funding deposit values", {
      asset: environment.asset,
      methodId: environment.methodId,
      baseUrl: configuration.baseUrl,
    });
    if (runtime.interaction.interactive && !options.validateOnly && !options.embedded) {
      await configureKrakenEnvironment(runtime, environment);
    }
    dashboard?.update("configure", "Reviewed the Kraken funding deposit values", {
      asset: environment.asset,
      methodId: environment.methodId,
      baseUrl: configuration.baseUrl,
    });
    if (options.validateOnly) {
      showKrakenEnvironment(runtime, configuration.baseUrl, environment);
      dashboard?.complete({ valid: true });
      if (!options.embedded) runtime.output.result({ valid: true });
      return undefined;
    }
    showKrakenEnvironment(runtime, configuration.baseUrl, environment);
    const client = fundingApi ?? new KrakenFundingClient(configuration, runtime.output);
    dashboard?.update("method", "Loading Kraken deposit funding methods", {
      asset: environment.asset,
    });
    const methodsResponse = await client.request("GET", "/funding/v1/methods/deposit", {
      query: {
        asset: { class: "currency", name: environment.asset },
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
    const selectedMethod = await selectFundingMethod(runtime, methods, environment.asset, environment.methodId);
    const methodId = requireText(selectedMethod.method_id, "Selected Kraken method has no method_id");
    dashboard?.update("method", "Selected the Kraken deposit funding method", selectedMethod);
    const probeStartedAt = new Date().toISOString();
    runtime.output.progress("kraken.deposit-method.selected", {
      methodId,
      methodName: selectedMethod.method_name,
      minimumAmount: selectedMethod.minimum_amount,
      networkId: selectedMethod.network?.network_id,
      networkName: selectedMethod.network?.network_name,
    });
    const existingDeposit = await resolveExistingDeposit(runtime, client, methodId, options);
    if (existingDeposit) {
      dashboard?.complete(existingDeposit);
      if (!runtime.output.verbose && !options.embedded) runtime.output.result(existingDeposit);
      return existingDeposit;
    }
    const expectedAmount =
      options.expectedAmount ??
      (options.allowExistingDeposit && runtime.interaction.interactive
        ? await runtime.interaction.text(`${environment.asset} amount to deposit`)
        : undefined);
    if (expectedAmount) {
      runtime.output.info(`Deposit exactly ${expectedAmount} ${environment.asset} at Kraken.`);
    }
    dashboard?.update("baseline", "Recording existing Kraken deposits", {
      methodId,
      probeStartedAt,
    });
    const baselineResponse = await listDeposits(client, methodId);
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
    if (!supportsDepositAddressGeneration(selectedMethod)) {
      const methodName = selectedMethod.method_name ?? "the selected method";
      runtime.output.info(
        [
          `Complete the ${environment.asset} deposit using ${methodName} in Kraken Web:`,
          "https://www.kraken.com/c",
          "Complete the deposit there before continuing.",
        ].join("\n"),
      );
      dashboard?.update(
        "instructions",
        "Complete the deposit in Kraken Web",
        selectedMethod,
        `${environment.asset} via ${methodName}`,
      );
      await waitForManualDeposit(runtime, environment.asset, methodName);
    } else {
      dashboard?.update("instructions", "Claiming Kraken deposit instructions", selectedMethod);
      await runtime.interaction.approve("Claim Kraken deposit instructions?");
      let claimResponse: Record<string, unknown>;
      try {
        claimResponse = await client.request("PUT", "/funding/v1/deposit/address", {
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
      dashboard?.update("instructions", "Kraken deposit instructions are ready", claimResponse);
      if (!isRecord(claimResponse.address_details) || !isRecord(claimResponse.address_details.fiat)) {
        throw new UsageError(
          `Kraken did not return fiat deposit instructions for the selected ${environment.asset} method`,
        );
      }
      await runtime.interaction.approve("Start polling Kraken after sending the deposit?");
    }
    dashboard?.update("detect", "Waiting for a successful Kraken deposit", {
      methodId,
      probeStartedAt,
      baselineDepositIds: [...baselineDepositIds],
    });
    const deposit = await waitForSuccessfulDeposit(
      runtime,
      client,
      environment,
      methodId,
      probeStartedAt,
      baselineDepositIds,
      dashboard,
    );
    dashboard?.complete(deposit);
    if (!runtime.output.verbose && !options.embedded) runtime.output.result(deposit);
    return deposit;
  } catch (error) {
    dashboard?.fail(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

async function resolveExistingDeposit(
  runtime: KrakenRuntime,
  client: KrakenFundingApi,
  methodId: string,
  options: KrakenOptions,
): Promise<KrakenDeposit | undefined> {
  if (!options.existingDepositId && (!options.allowExistingDeposit || !runtime.interaction.interactive)) {
    return undefined;
  }
  const successfulDeposits = (await listAllDeposits(client, methodId)).filter(
    (deposit) => deposit.method_id === methodId && deposit.status?.toLowerCase() === "success" && deposit.deposit_id,
  );
  if (options.existingDepositId) {
    const deposit = successfulDeposits.find((candidate) => candidate.deposit_id === options.existingDepositId);
    if (!deposit) {
      throw new UsageError(`Successful Kraken deposit ${options.existingDepositId} was not found for this method`);
    }
    return deposit;
  }
  if (!successfulDeposits.length) return undefined;
  const source = await runtime.interaction.choose("Kraken deposit source", [
    { name: "Use an existing successful BRL deposit", value: "existing" as const },
    { name: "Wait for a new BRL deposit", value: "new" as const },
  ]);
  if (source === "new") return undefined;
  const depositId = await runtime.interaction.choose(
    "Select the successful Kraken BRL deposit",
    successfulDeposits.map((deposit) => ({
      name: depositChoiceName(deposit),
      value: requireText(deposit.deposit_id, "Kraken deposit has no deposit_id"),
    })),
  );
  return successfulDeposits.find((deposit) => deposit.deposit_id === depositId)!;
}

async function listAllDeposits(client: KrakenFundingApi, methodId: string): Promise<KrakenDeposit[]> {
  const deposits: KrakenDeposit[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const response = await client.request("GET", "/funding/v1/deposits", {
      query: cursor ? { cursor } : { scope: { method_id: methodId }, limit: 500 },
      operation: "List Kraken funding deposits for selection",
    });
    deposits.push(...depositsFrom(response));
    cursor = typeof response.next_cursor === "string" && response.next_cursor.trim()
      ? response.next_cursor
      : undefined;
    if (!cursor) return deposits;
  }
  throw new UsageError("Kraken funding deposits exceeded the 10-page selection limit");
}

function depositChoiceName(deposit: KrakenDeposit): string {
  const amount = isRecord(deposit.amount) && typeof deposit.amount.amount === "string"
    ? deposit.amount.amount
    : "unknown amount";
  const asset = isRecord(deposit.amount) && isRecord(deposit.amount.asset) && typeof deposit.amount.asset.name === "string"
    ? deposit.amount.asset.name
    : "BRL";
  return [deposit.create_time ?? "Unknown date", `${amount} ${asset}`, deposit.deposit_id].join(" · ");
}

function showKrakenEnvironment(runtime: KrakenRuntime, baseUrl: string, environment: KrakenEnvironment): void {
  runtime.output.progress("kraken.environment.validated", {
    baseUrl,
    asset: environment.asset,
    methodId: environment.methodId ?? "Interactive selection",
    pollIntervalSeconds: environment.pollIntervalSeconds,
    timeoutSeconds: environment.timeoutSeconds,
  });
}

function supportsDepositAddressGeneration(method: KrakenFundingMethod): boolean {
  const status = method.deposit?.address_generation?.status?.toLowerCase();
  return status === "limited" || status === "unlimited";
}

async function waitForManualDeposit(runtime: KrakenRuntime, asset: string, methodName: string): Promise<void> {
  if (!runtime.interaction.interactive) {
    throw new UsageError(`${methodName} requires an interactive Kraken Web deposit before polling`);
  }
  while (
    !(await runtime.interaction.confirm(
      `Have you completed the ${asset} deposit using ${methodName} in Kraken Web and are you ready to start polling?`,
      false,
    ))
  ) {}
}

export async function configureKrakenEnvironment(
  runtime: KrakenRuntime,
  environment: KrakenEnvironment,
): Promise<void> {
  type Field = "continue" | "asset" | "methodId" | "pollInterval" | "timeout";
  while (true) {
    const field = await runtime.interaction.choose<Field>("Review Kraken prototype values", [
      { name: "Use these values", value: "continue" },
      { name: `Asset: ${environment.asset}`, value: "asset" },
      {
        name: `Method ID: ${environment.methodId ?? "Interactive selection"}`,
        value: "methodId",
      },
      {
        name: `Poll interval: ${environment.pollIntervalSeconds} seconds`,
        value: "pollInterval",
      },
      {
        name: `Timeout: ${environment.timeoutSeconds} seconds`,
        value: "timeout",
      },
    ]);
    if (field === "continue") return;
    if (field === "asset") {
      environment.asset = (
        await runtime.interaction.text("Kraken deposit asset", undefined, environment.asset)
      ).toUpperCase();
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

export function resolveKrakenEnvironment(environment: Environment, options: KrakenOptions): KrakenEnvironment {
  return {
    asset: (options.asset ?? "BRL").toUpperCase(),
    methodId: options.methodId,
    pollIntervalSeconds: positiveNumber(
      options.pollIntervalSeconds,
      "--poll-interval-seconds",
      3,
    ),
    timeoutSeconds: positiveNumber(
      options.timeoutSeconds,
      "--timeout-seconds",
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
  methodId: string,
  startTime?: string,
): Promise<Record<string, unknown>> {
  return client.request("GET", "/funding/v1/deposits", {
    query: {
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
  dashboard?: KrakenDashboard,
): Promise<KrakenDeposit> {
  const deadline = Date.now() + environment.timeoutSeconds * 1000;
  let previousState = "";
  let lastDeposit: KrakenDeposit | undefined;
  while (Date.now() < deadline) {
    const response = await listDeposits(client, methodId, probeStartedAt);
    const newDeposits = depositsFrom(response).filter(
      (deposit) =>
        deposit.method_id === methodId && Boolean(deposit.deposit_id) && !baselineDepositIds.has(deposit.deposit_id!),
    );
    if (newDeposits.length > 1) {
      showCompleteRecord(runtime, "kraken.deposit-detection.ambiguous", {
        deposits: newDeposits,
      });
      throw new UsageError("More than one new Kraken deposit matched this prototype run");
    }
    const deposit = newDeposits[0];
    if (deposit) {
      lastDeposit = deposit;
      dashboard?.update(
        "detect",
        "Waiting for a successful Kraken deposit",
        deposit,
        `Status: ${deposit.status ?? "unknown"}`,
      );
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
    showCompleteRecord(runtime, "kraken.deposit.timeout", {
      deposit: lastDeposit,
    });
  }
  throw new UsageError("Timed out waiting for a successful Kraken deposit");
}

function depositsFrom(response: Record<string, unknown>): KrakenDeposit[] {
  if (Object.keys(response).length === 0) return [];
  return requireArray<KrakenDeposit>(response.deposits, "Kraken funding-deposit response did not contain deposits");
}

function showCompleteRecord(runtime: KrakenRuntime, event: string, value: Record<string, unknown>): void {
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

async function promptPositiveNumber(runtime: KrakenRuntime, label: string, defaultValue: number): Promise<number> {
  while (true) {
    const value = await runtime.interaction.text(label, undefined, String(defaultValue));
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
    runtime.output.error(`${label} must be greater than zero`);
  }
}
