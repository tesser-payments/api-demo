import { requireAccountId, requireWalletAddress } from "../accounts.ts";
import { firstValue } from "../config.ts";
import { UsageError } from "../errors.ts";
import { requireData } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { resolveWallet } from "./wallet.ts";

const networks = ["BASE_SEPOLIA", "ETHEREUM_SEPOLIA", "POLYGON_AMOY"] as const;
const riskStatuses = [
  "automatically_approved",
  "awaiting_decision",
  "automatically_rejected",
] as const;

export type SimulateInboundOptions = {
  walletId?: string;
  network?: string;
  mockedRiskStatus?: string;
  count?: number;
  yes?: boolean;
};

export async function runSimulateInbound(
  runtime: Runtime,
  options: SimulateInboundOptions,
): Promise<void> {
  const configuredNetwork = (
    options.network ??
    firstValue(runtime.environment, "WITHDRAWAL_FROM_NETWORK", "PAYMENT_NETWORK") ??
    "BASE_SEPOLIA"
  ).toUpperCase();
  const network = networks.includes(configuredNetwork as (typeof networks)[number])
    ? configuredNetwork
    : await runtime.interaction.choose(
        "Inbound network",
        networks.map((value) => ({ name: value, value })),
      );
  if (!networks.includes(network as (typeof networks)[number])) {
    throw new UsageError(`Unsupported inbound network ${network}`);
  }
  const configuredRiskStatus = options.mockedRiskStatus?.toLowerCase() ?? "automatically_approved";
  const riskStatus = riskStatuses.includes(configuredRiskStatus as (typeof riskStatuses)[number])
    ? configuredRiskStatus
    : await runtime.interaction.choose(
        "Mocked risk status",
        riskStatuses.map((value) => ({ name: value, value })),
      );
  if (!riskStatuses.includes(riskStatus as (typeof riskStatuses)[number])) {
    throw new UsageError(`Unsupported mocked risk status ${riskStatus}`);
  }
  const count = options.count ?? 1;
  if (!Number.isInteger(count) || count < 1) throw new UsageError("Count must be a positive integer");
  const walletId =
    options.walletId ??
    firstValue(runtime.environment, "WITHDRAWAL_SOURCE_WALLET_ID", "PAYMENT_SOURCE_WALLET_ID");
  const wallet = await resolveWallet(runtime, {
    walletId,
    currency: "USDC",
    network,
  });
  const resolvedWalletId = requireAccountId(wallet, "Destination wallet");
  const address = requireWalletAddress(wallet, "Destination wallet");
  if (!options.yes) {
    await runtime.interaction.approve(
      `Send ${count} simulated inbound payment(s) of 1 USDC to ${address} on ${network}?`,
    );
  }
  const results: unknown[] = [];
  for (let callNumber = 1; callNumber <= count; callNumber += 1) {
    const response = await runtime.client.request("POST", "/v1/payments/simulate-inbound", {
      body: {
        to_account: resolvedWalletId,
        mocked_risk_status: riskStatus,
        network,
      },
      operation: `Simulate inbound payment ${callNumber}/${count}`,
    });
    const result = requireData(response, `Simulate inbound payment ${callNumber}/${count}`);
    results.push(result);
    runtime.output.progress("simulate-inbound.completed", {
      call: `${callNumber}/${count}`,
      walletId: resolvedWalletId,
      network,
    });
  }
  runtime.output.result({ count, results });
}
