import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import type {
  KrakenFundingApi,
  KrakenFundingRequest,
  KrakenSpotApi,
} from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import type { KrakenRuntime } from "../src/workflows/kraken.ts";
import {
  runKrakenRegisterAddress,
  runKrakenWithdraw,
} from "../src/workflows/kraken-withdraw.ts";

describe("Kraken withdrawal workflows", () => {
  test("registers a new address for the selected withdrawal network", async () => {
    const responses: Record<string, unknown>[] = [
      { methods: [withdrawalMethod()] },
      { address_id: "AB12345-12345-123456", verified: true },
    ];
    const request = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: KrakenFundingRequest,
      ) => responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenRegisterAddress(
      runtime(),
      {
        methodId: "method-1",
        address: "0x1234",
        name: "Treasury target",
      },
      { request } as KrakenFundingApi,
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toBe("/funding/v1/addresses");
    expect(request.mock.calls[1]?.[2].body).toEqual({
      scope: { method_id: "method-1" },
      address_details: { crypto: { address: "0x1234" } },
      name: "Treasury target",
    });
    expect(standardOutput.mock.calls.at(-1)?.[0]).toContain('"address_id": "AB12345-12345-123456"');
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("quotes and completes a withdrawal to an existing verified address", async () => {
    const fundingResponses: Record<string, unknown>[] = [
      { methods: [withdrawalMethod()] },
      {
        addresses: [
          {
            address_id: "AB12345-12345-123456",
            name: "Treasury target",
            verified: true,
            address_details: { crypto: { address: "0x1234" } },
          },
        ],
      },
      {
        fee: { asset: { class: "currency", name: "USDC" }, amount: "1" },
        gross_amount: { asset: { class: "currency", name: "USDC" }, amount: "5" },
        net_amount: { asset: { class: "currency", name: "USDC" }, amount: "4" },
        withdrawal_fee_token: "fee-token",
      },
      {
        withdrawal_id: "withdrawal-1",
        gross_amount: { asset_amount: { asset: { class: "currency", name: "USDC" }, amount: "5" } },
        net_amount: { asset_amount: { asset: { class: "currency", name: "USDC" }, amount: "4" } },
        fee: { asset_amount: { asset: { class: "currency", name: "USDC" }, amount: "1" } },
      },
      {
        withdrawals: [
          {
            withdrawal_id: "withdrawal-1",
            method_id: "method-1",
            address_id: "AB12345-12345-123456",
            status: "success",
          },
        ],
      },
    ];
    const fundingRequest = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: KrakenFundingRequest,
      ) => fundingResponses.shift()!,
    );
    const spotRequest = mock(async () => ({
      error: [],
      result: { USDC: { balance: "10", hold_trade: "0" } },
    }));
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenWithdraw(
      runtime(),
      {
        methodId: "method-1",
        addressId: "AB12345-12345-123456",
        amount: "5",
        feeMode: "total",
        pollIntervalSeconds: 0.001,
        timeoutSeconds: 1,
      },
      { request: fundingRequest } as KrakenFundingApi,
      { request: spotRequest } as KrakenSpotApi,
    );

    expect(fundingRequest).toHaveBeenCalledTimes(5);
    expect(fundingRequest.mock.calls[2]?.[2].query).toMatchObject({
      amount: "5",
      fee_included: true,
    });
    expect(fundingRequest.mock.calls[3]?.[2].body).toMatchObject({
      scope: { method_id: "method-1" },
      address_id: "AB12345-12345-123456",
      fee: { quoted_fee: { token: "fee-token" }, fee_included: true },
      expected_address: "0x1234",
    });
    expect(standardOutput.mock.calls.at(-1)?.[0]).toContain('"status": "success"');
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });
});

function withdrawalMethod(): Record<string, unknown> {
  return {
    asset: { class: "currency", name: "USDC" },
    method_id: "method-1",
    method_name: "USDC",
    minimum_amount: "1",
    network: { network_id: "network-1", network_name: "Base" },
  };
}

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
