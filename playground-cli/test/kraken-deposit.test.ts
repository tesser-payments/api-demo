import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import type { KrakenFundingApi } from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import { runKrakenDepositShow } from "../src/workflows/kraken-deposit.ts";
import type { KrakenRuntime } from "../src/workflows/kraken.ts";

describe("Kraken deposit inspection", () => {
  test("shows the requested deposit across paginated responses", async () => {
    const requestedDeposit = {
      deposit_id: "deposit-2",
      status: "success",
      fee: null,
      create_time: "2026-09-03T12:00:00Z",
    };
    const responses = [
      { deposits: [{ deposit_id: "deposit-1" }], next_cursor: "next-page" },
      { deposits: [requestedDeposit] },
    ];
    const request = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: unknown,
      ) => responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );

    const result = await runKrakenDepositShow(
      runtime(),
      "deposit-2",
      {},
      { request } as KrakenFundingApi,
    );

    expect(result).toEqual(requestedDeposit);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[2]).toEqual({
      query: { account_id: "account-id", limit: 500 },
      operation: "List Kraken funding deposits",
    });
    expect(request.mock.calls[1]?.[2]).toEqual({
      query: { cursor: "next-page" },
      operation: "List Kraken funding deposits",
    });
    expect(standardOutput.mock.calls.at(-1)?.[0]).toContain('"fee": null');
    standardOutput.mockRestore();
  });

  test("selects the only deposit when no ID is provided", async () => {
    const deposit = { deposit_id: "deposit-1", status: "success" };
    const request = mock(async () => ({ deposits: [deposit] }));
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(
      () => true,
    );

    const result = await runKrakenDepositShow(
      runtime(),
      undefined,
      {},
      { request } as KrakenFundingApi,
    );

    expect(result).toEqual(deposit);
    standardOutput.mockRestore();
  });

  test("rejects an unknown deposit ID", async () => {
    const request = mock(async () => ({
      deposits: [{ deposit_id: "deposit-1" }],
    }));

    await expect(
      runKrakenDepositShow(
        runtime(),
        "missing-deposit",
        {},
        { request } as KrakenFundingApi,
      ),
    ).rejects.toThrow("Kraken deposit missing-deposit was not found");
  });
});

function runtime(): KrakenRuntime {
  return {
    environment: {
      KRAKEN_ACCOUNT_ID: "account-id",
    } as Environment,
    interaction: new NonInteractiveInteraction(),
    output: new Output("json", false),
  };
}
