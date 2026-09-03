import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import type { KrakenSpotApi, KrakenSpotRequest } from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import type { KrakenRuntime } from "../src/workflows/kraken.ts";
import { runKrakenBalances } from "../src/workflows/kraken-balances.ts";
import { runKrakenSwap } from "../src/workflows/kraken-swap.ts";

describe("Kraken account workflows", () => {
  test("shows total, held, and available balances", async () => {
    const request = mock(async () => ({
      error: [],
      result: {
        ZUSD: { balance: "10", hold_trade: "1.5" },
        USDC: { balance: "4", hold_trade: "0" },
      },
    }));
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);

    const balances = await runKrakenBalances(runtime(), { request } as KrakenSpotApi);

    expect(balances).toEqual([
      {
        asset: "USD",
        krakenAsset: "ZUSD",
        balance: 10,
        credit: 0,
        creditUsed: 0,
        tradingHold: 1.5,
        available: 8.5,
      },
      {
        asset: "USDC",
        krakenAsset: "USDC",
        balance: 4,
        credit: 0,
        creditUsed: 0,
        tradingHold: 0,
        available: 4,
      },
    ]);
    expect(standardOutput.mock.calls[0]?.[0]).toContain('"available": 8.5');
    standardOutput.mockRestore();
  });

  test("validates and executes a USD to USDC market order using quote volume", async () => {
    const responses: Record<string, unknown>[] = [
      { error: [], result: { ZUSD: { balance: "10", hold_trade: "0" } } },
      {
        error: [],
        result: {
          USDCUSD: {
            altname: "USDCUSD",
            wsname: "USDC/USD",
            base: "USDC",
            quote: "ZUSD",
            status: "online",
          },
        },
      },
      { error: [], result: { descr: { order: "validated" } } },
      { error: [], result: { txid: ["order-1"] } },
      {
        error: [],
        result: {
          "order-1": {
            status: "closed",
            vol_exec: "5.01",
            cost: "5.00",
            fee: "0.01",
            price: "0.998",
          },
        },
      },
    ];
    const request = mock(
      async (_method: "GET" | "POST", _path: string, _request: KrakenSpotRequest) =>
        responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenSwap(
      runtime(),
      { amount: "5", pollIntervalSeconds: 0.001, timeoutSeconds: 1 },
      { request } as KrakenSpotApi,
    );

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[2]?.[1]).toBe("/0/private/AddOrder");
    expect(request.mock.calls[2]?.[2].body).toMatchObject({
      pair: "USDCUSD",
      ordertype: "market",
      type: "buy",
      volume: "5",
      oflags: "viqc",
      validate: true,
    });
    expect(request.mock.calls[3]?.[2].body).not.toHaveProperty("validate");
    expect(standardOutput.mock.calls.at(-1)?.[0]).toContain('"orderId": "order-1"');
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });
});

function runtime(): KrakenRuntime {
  return {
    environment: {
      KRAKEN_API_KEY: "api-key",
      KRAKEN_API_SECRET: "c2VjcmV0",
    } as Environment,
    interaction: new NonInteractiveInteraction(),
    output: new Output("json", false),
  };
}
