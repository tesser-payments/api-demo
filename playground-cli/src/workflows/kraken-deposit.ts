import { firstValue, getKrakenConfiguration } from "../config.ts";
import { UsageError } from "../errors.ts";
import {
  KrakenFundingClient,
  type KrakenFundingApi,
} from "../kraken.ts";
import type { KrakenRuntime } from "./kraken.ts";

type KrakenDeposit = Record<string, unknown> & {
  deposit_id?: string;
  status?: string;
  create_time?: string;
};

export type KrakenDepositShowOptions = {
  accountId?: string;
};

export async function runKrakenDepositShow(
  runtime: KrakenRuntime,
  depositId: string | undefined,
  options: KrakenDepositShowOptions = {},
  fundingApi?: KrakenFundingApi,
): Promise<KrakenDeposit> {
  const client =
    fundingApi ??
    new KrakenFundingClient(
      getKrakenConfiguration(runtime.environment),
      runtime.output,
    );
  const accountId =
    options.accountId ?? firstValue(runtime.environment, "KRAKEN_ACCOUNT_ID");
  const deposits = await loadDeposits(client, accountId);
  const selectedDeposit = depositId
    ? deposits.find((deposit) => deposit.deposit_id === depositId)
    : await runtime.interaction.choose(
        "Select Kraken deposit",
        deposits.map((deposit) => ({
          name: depositChoiceName(deposit),
          value: deposit,
        })),
      );

  if (!selectedDeposit) {
    throw new UsageError(`Kraken deposit ${depositId} was not found`);
  }

  runtime.output.result(selectedDeposit);
  return selectedDeposit;
}

async function loadDeposits(
  client: KrakenFundingApi,
  accountId: string | undefined,
): Promise<KrakenDeposit[]> {
  const deposits: KrakenDeposit[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    const response = await client.request("GET", "/funding/v1/deposits", {
      query: cursor ? { cursor } : { account_id: accountId, limit: 500 },
      operation: "List Kraken funding deposits",
    });
    deposits.push(...depositsFrom(response));
    const nextCursor = optionalText(response.next_cursor ?? response.nextCursor);
    if (!nextCursor || seenCursors.has(nextCursor)) break;
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor);

  if (!deposits.length) {
    throw new UsageError("Kraken returned no funding deposits");
  }
  return deposits;
}

function depositsFrom(response: Record<string, unknown>): KrakenDeposit[] {
  if (!Array.isArray(response.deposits)) {
    throw new UsageError(
      "Kraken funding-deposit response did not contain deposits",
    );
  }
  if (response.deposits.some((deposit) => !isRecord(deposit))) {
    throw new UsageError("Kraken funding-deposit response contained an invalid deposit");
  }
  return response.deposits as KrakenDeposit[];
}

function depositChoiceName(deposit: KrakenDeposit): string {
  const depositId = optionalText(deposit.deposit_id) ?? "Missing deposit ID";
  const status = optionalText(deposit.status) ?? "unknown status";
  const createTime = optionalText(deposit.create_time) ?? "unknown time";
  return `${depositId} · ${status} · ${createTime}`;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
