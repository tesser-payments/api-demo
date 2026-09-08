import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import type { KrakenFundingApi, KrakenFundingRequest, KrakenSpotApi, KrakenSpotRequest } from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import { runKrakenCliOnlyDeposit } from "../src/workflows/kraken-cli-only-deposit.ts";
import type { KrakenRuntime } from "../src/workflows/kraken.ts";

const walletAddress = "0x1111111111111111111111111111111111111111";
const transactionHash = `0x${"a".repeat(64)}`;

describe("Kraken CLI-only deposit", () => {
  test("deposits BRL, executes both market orders, and withdraws USDC to the supplied address", async () => {
    const fundingResponses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "USDC" },
            method_id: "base-method",
            method_name: "Standard",
            minimum_amount: "1",
            network: {
              network_id: "base-network",
              network_name: "Base",
              contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              on_chain_asset_symbol: "USDC",
            },
          },
        ],
      },
      {
        addresses: [
          {
            address_id: "AB12345-12345-123456",
            verified: true,
            address_details: { crypto: { address: walletAddress } },
          },
        ],
      },
      {
        methods: [
          {
            asset: { class: "currency", name: "BRL" },
            method_id: "pix-method",
            method_name: "Pix (PayAmigo)",
            deposit: { address_generation: { status: "unlimited" } },
          },
        ],
      },
      { deposits: [] },
      { address_details: { fiat: { pix_code: "pix-code" } } },
      {
        deposits: [
          {
            deposit_id: "deposit-id",
            method_id: "pix-method",
            status: "success",
            amount: { asset: { class: "currency", name: "BRL" }, amount: "10.00" },
          },
        ],
      },
      {
        gross_amount: { asset: { class: "currency", name: "USDC" }, amount: "1.97005025" },
        net_amount: { asset: { class: "currency", name: "USDC" }, amount: "1.87005025" },
        fee: { asset: { class: "currency", name: "USDC" }, amount: "0.10" },
        withdrawal_fee_token: "fee-token",
      },
      {
        withdrawal_id: "FT12345-1234567890123456789012",
        gross_amount: {
          asset_amount: { asset: { class: "currency", name: "USDC" }, amount: "1.97005025" },
        },
        net_amount: {
          asset_amount: { asset: { class: "currency", name: "USDC" }, amount: "1.87005025" },
        },
        fee: {
          asset_amount: { asset: { class: "currency", name: "USDC" }, amount: "0.10" },
        },
      },
      {
        withdrawals: [
          {
            withdrawal_id: "FT12345-1234567890123456789012",
            status: "success",
            onchain_transaction: { transaction_hash: transactionHash },
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
    const spotResponses: Record<string, unknown>[] = [
      { result: { BRL1: { balance: "10", hold_trade: "0" } } },
      {
        result: {
          BRL1USD: {
            altname: "BRL1USD",
            base: "BRL1",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { result: { descr: { order: "validated" } } },
      { result: { txid: ["brl-usd-order"] } },
      {
        result: {
          "brl-usd-order": {
            status: "closed",
            vol_exec: "10.00",
            cost: "2.000025",
            fee: "0.01",
            price: "0.20",
          },
        },
      },
      { result: { ZUSD: { altname: "USD", decimals: 4 } } },
      { result: { ZUSD: { balance: "1.99", hold_trade: "0" } } },
      {
        result: {
          USDCUSD: {
            altname: "USDCUSD",
            base: "USDC",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { result: { descr: { order: "validated" } } },
      { result: { txid: ["usd-usdc-order"] } },
      {
        result: {
          "usd-usdc-order": {
            status: "closed",
            vol_exec: "1.98",
            cost: "1.99",
            fee: "0.01",
            price: "1.005",
          },
        },
      },
    ];
    const spotRequest = mock(
      async (_method: "GET" | "POST", _path: string, _request: KrakenSpotRequest) =>
        spotResponses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenCliOnlyDeposit(
      runtime(),
      {
        amount: "10",
        destinationAddress: walletAddress,
        network: "BASE",
        depositMethodId: "pix-method",
        withdrawalMethodId: "base-method",
        pollIntervalSeconds: 0.001,
        timeoutSeconds: 1,
      },
      {
        fundingApi: { request: fundingRequest } as KrakenFundingApi,
        spotApi: { request: spotRequest } as KrakenSpotApi,
      },
    );

    expect(fundingRequest.mock.calls.find((call) => call[1] === "/funding/v1/withdrawals")?.[2].body).toMatchObject({
      scope: { method_id: "base-method" },
      address_id: "AB12345-12345-123456",
      amount: { asset_amount: { amount: "1.97005025" } },
      fee: { quoted_fee: { token: "fee-token" }, fee_included: true },
      expected_address: walletAddress,
    });
    const addOrderCalls = spotRequest.mock.calls.filter((call) => call[1] === "/0/private/AddOrder");
    expect(addOrderCalls).toHaveLength(4);
    expect(addOrderCalls[0]?.[2].body).toMatchObject({
      pair: "BRL1USD",
      ordertype: "market",
      type: "sell",
      volume: "10.00",
      oflags: "fciq",
      validate: true,
    });
    expect(addOrderCalls[2]?.[2].body).toMatchObject({
      pair: "USDCUSD",
      ordertype: "market",
      type: "buy",
      volume: "1.99",
      oflags: "viqc,fcib",
      validate: true,
    });
    const output = String(standardOutput.mock.calls.at(-1)?.[0]);
    expect(output).toContain('"mode": "cli-only"');
    expect(output).toContain('"net_amount": "1.87005025"');
    expect(output).toContain(transactionHash);
    expect(output).not.toContain(walletAddress);
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("rejects a configured withdrawal method that is not native USDC on the destination network", async () => {
    const fundingRequest = mock(async () => ({
      methods: [
        {
          asset: { class: "currency", name: "USDC" },
          method_id: "ethereum-method",
          network: {
            network_name: "Ethereum",
            contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            on_chain_asset_symbol: "USDC",
          },
        },
      ],
    }));

    await expect(
      runKrakenCliOnlyDeposit(
        runtime(),
        {
          amount: "10",
          destinationAddress: walletAddress,
          network: "BASE",
          withdrawalMethodId: "ethereum-method",
        },
        { fundingApi: { request: fundingRequest } as KrakenFundingApi },
      ),
    ).rejects.toThrow("is not native USDC on BASE");
  });

  test("resumes from the available USD without repeating the deposit or BRL order", async () => {
    const fundingResponses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "USDC" },
            method_id: "base-method",
            minimum_amount: "1",
            network: {
              network_name: "Base",
              contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              on_chain_asset_symbol: "USDC",
            },
          },
        ],
      },
      {
        addresses: [
          {
            address_id: "AB12345-12345-123456",
            verified: true,
            address_details: { crypto: { address: walletAddress } },
          },
        ],
      },
      {
        gross_amount: { asset: { class: "currency", name: "USDC" }, amount: "9.5808" },
        net_amount: { asset: { class: "currency", name: "USDC" }, amount: "9.4808" },
        fee: { asset: { class: "currency", name: "USDC" }, amount: "0.10" },
        withdrawal_fee_token: "fee-token",
      },
      {
        withdrawal_id: "FT12345-1234567890123456789012",
        gross_amount: { asset_amount: { amount: "9.5808" } },
        net_amount: { asset_amount: { amount: "9.4808" } },
        fee: { asset_amount: { amount: "0.10" } },
      },
      {
        withdrawals: [
          {
            withdrawal_id: "FT12345-1234567890123456789012",
            status: "success",
            onchain_transaction: { transaction_hash: transactionHash },
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
    const spotResponses: Record<string, unknown>[] = [
      { result: { ZUSD: { balance: "9.6681", hold_trade: "0" } } },
      {
        result: {
          USDCUSD: {
            altname: "USDCUSD",
            base: "USDC",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { result: { descr: { order: "validated" } } },
      { result: { txid: ["usd-usdc-order"] } },
      {
        result: {
          "usd-usdc-order": {
            status: "closed",
            vol_exec: "9.60",
            cost: "9.6681",
            fee: "0.0193362",
            price: "1.00709375",
          },
        },
      },
    ];
    const spotRequest = mock(
      async (_method: "GET" | "POST", _path: string, _request: KrakenSpotRequest) =>
        spotResponses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await runKrakenCliOnlyDeposit(
      runtime(),
      {
        resumeUsdAmount: "9.6681",
        destinationAddress: walletAddress,
        network: "BASE",
        withdrawalMethodId: "base-method",
        pollIntervalSeconds: 0.001,
        timeoutSeconds: 1,
      },
      {
        fundingApi: { request: fundingRequest } as KrakenFundingApi,
        spotApi: { request: spotRequest } as KrakenSpotApi,
      },
    );

    const addOrderCalls = spotRequest.mock.calls.filter((call) => call[1] === "/0/private/AddOrder");
    expect(addOrderCalls).toHaveLength(2);
    expect(addOrderCalls[0]?.[2].body).toMatchObject({
      pair: "USDCUSD",
      type: "buy",
      volume: "9.6681",
      oflags: "viqc,fcib",
      validate: true,
    });
    expect(fundingRequest.mock.calls.some((call) => call[1] === "/funding/v1/deposits")).toBeFalse();
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("stops when a closed market order did not consume the full input", async () => {
    const fundingResponses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "USDC" },
            method_id: "base-method",
            network: {
              network_name: "Base",
              contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              on_chain_asset_symbol: "USDC",
            },
          },
        ],
      },
      {
        addresses: [
          {
            address_id: "AB12345-12345-123456",
            verified: true,
            address_details: { crypto: { address: walletAddress } },
          },
        ],
      },
      {
        methods: [
          {
            asset: { class: "currency", name: "BRL" },
            method_id: "pix-method",
            method_name: "Pix (PayAmigo)",
          },
        ],
      },
      {
        deposits: [
          {
            deposit_id: "deposit-id",
            method_id: "pix-method",
            status: "success",
            amount: { asset: { class: "currency", name: "BRL" }, amount: "10.00" },
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
    const spotResponses: Record<string, unknown>[] = [
      { result: { BRL1: { balance: "10", hold_trade: "0" } } },
      {
        result: {
          BRL1USD: {
            altname: "BRL1USD",
            base: "BRL1",
            quote: "ZUSD",
            status: "online",
            lot_decimals: 8,
          },
        },
      },
      { result: { descr: { order: "validated" } } },
      { result: { txid: ["brl-usd-order"] } },
      {
        result: {
          "brl-usd-order": {
            status: "closed",
            vol_exec: "9.99",
            cost: "2.00",
            fee: "0.01",
            price: "0.20",
          },
        },
      },
    ];
    const spotRequest = mock(
      async (_method: "GET" | "POST", _path: string, _request: KrakenSpotRequest) =>
        spotResponses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runKrakenCliOnlyDeposit(
        runtime(),
        {
          amount: "10",
          destinationAddress: walletAddress,
          network: "BASE",
          depositMethodId: "pix-method",
          krakenDepositId: "deposit-id",
          withdrawalMethodId: "base-method",
          pollIntervalSeconds: 0.001,
          timeoutSeconds: 1,
        },
        {
          fundingApi: { request: fundingRequest } as KrakenFundingApi,
          spotApi: { request: spotRequest } as KrakenSpotApi,
        },
      ),
    ).rejects.toThrow("consumed 9.99 of 10.00 BRL");

    expect(spotRequest).toHaveBeenCalledTimes(5);
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("requires the destination address to be registered manually in Kraken", async () => {
    const fundingResponses = [
      {
        methods: [
          {
            asset: { class: "currency", name: "USDC" },
            method_id: "base-method",
            network: {
              network_name: "Base",
              contract_address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
              on_chain_asset_symbol: "USDC",
            },
          },
        ],
      },
      { addresses: [] },
    ];
    const fundingRequest = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: KrakenFundingRequest,
      ) => fundingResponses.shift()!,
    );

    await expect(
      runKrakenCliOnlyDeposit(
        runtime(),
        {
          amount: "10",
          destinationAddress: walletAddress,
          network: "BASE",
          withdrawalMethodId: "base-method",
        },
        { fundingApi: { request: fundingRequest } as KrakenFundingApi },
      ),
    ).rejects.toThrow("must be registered manually in Kraken");

    expect(fundingRequest).toHaveBeenCalledTimes(2);
    expect(fundingRequest.mock.calls.every((call) => call[0] === "GET")).toBeTrue();
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
