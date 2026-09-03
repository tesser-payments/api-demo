import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import type { HttpResponse, TesserClient } from "../src/http.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import { runKrakenDeposit } from "../src/workflows/kraken-e2e-deposit.ts";

const ledgerBefore = {
  id: "ledger-id",
  type: "ledger",
  provider: "KRAKEN",
  is_managed: true,
  assets: [
    { currency: "BRL", network: null, available_balance: "0" },
    { currency: "CAD", network: null, available_balance: "0" },
    { currency: "USDC", network: null, available_balance: "0" },
    { currency: "USDT", network: null, available_balance: "0" },
  ],
};

const sourceBank = {
  id: "bank-id",
  type: "fiat_bank",
  tenant_id: null,
  counterparty_id: null,
};

const desired = {
  from: { account_id: "bank-id", amount: "50", currency: "BRL" },
  to: { account_id: "ledger-id", amount: null, currency: "BRL" },
};

const planned = {
  id: "deposit-id",
  desired,
  actual: {
    from: { account_id: null, amount: null, currency: null },
    to: { account_id: null, amount: null, currency: null },
  },
  steps: [
    {
      id: "step-id",
      provider_key: "kraken",
      status: "created",
      estimated: {
        from: { account_id: "bank-id", amount: "50", currency: "BRL" },
        to: { account_id: "ledger-id", amount: "50", currency: "BRL" },
      },
    },
  ],
};

const completed = {
  ...planned,
  actual: {
    from: { account_id: "bank-id", amount: "50", currency: "BRL" },
    to: { account_id: "ledger-id", amount: "50", currency: "BRL" },
  },
  steps: [
    {
      ...planned.steps[0],
      status: "completed",
      actual: {
        from: { account_id: "bank-id", amount: "50", currency: "BRL" },
        to: { account_id: "ledger-id", amount: "50", currency: "BRL" },
      },
    },
  ],
};

describe("Kraken Tesser deposit workflow", () => {
  test("plans a BRL deposit and waits for Tesser reconciliation", async () => {
    let depositReads = 0;
    let ledgerReads = 0;
    let instructionReads = 0;
    const request = mock(async (method: string, path: string, _options?: unknown) => {
      if (path === "/v1/accounts/ledger-id") {
        ledgerReads += 1;
        return response({
          data:
            ledgerReads === 1
              ? ledgerBefore
              : {
                  ...ledgerBefore,
                  assets: ledgerBefore.assets.map((asset) =>
                    asset.currency === "BRL"
                      ? { ...asset, available_balance: "50" }
                      : asset,
                  ),
                },
        });
      }
      if (path === "/v1/accounts/bank-id") {
        return response({ data: sourceBank });
      }
      if (method === "POST" && path === "/v1/treasury/deposits") {
        return response({ data: { id: "deposit-id", desired, steps: [] } }, 201);
      }
      if (path === "/v1/treasury/deposits/deposit-id/instructions") {
        instructionReads += 1;
        if (instructionReads === 1) {
          return response(
            { error_code: "treasury-2100", error_message: "Still planning" },
            409,
          );
        }
        return response({
          data: {
            from_account: { id: "bank-id" },
            to_account: {
              bank_account_number: "NOT_PAYABLE",
              bank_identifier_code: "TEST_ONLY",
            },
            amount: "50.00",
            currency: "BRL",
          },
        });
      }
      if (path === "/v1/treasury/deposits/deposit-id") {
        depositReads += 1;
        if (depositReads === 1) {
          return response({ data: { id: "deposit-id", desired, steps: [] } });
        }
        return response({ data: depositReads === 2 ? planned : completed });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    await runKrakenDeposit(runtime(request), {
      sourceBankId: "bank-id",
      krakenLedgerId: "ledger-id",
      amount: "50.00",
      organizationReferenceId: "kraken-reference",
      pollIntervalSeconds: 0.001,
      timeoutSeconds: 1,
    });

    const createCall = request.mock.calls.find(
      (call) => call[0] === "POST" && call[1] === "/v1/treasury/deposits",
    );
    expect(createCall?.[2]).toEqual({
      body: {
        organization_reference_id: "kraken-reference",
        desired: {
          from: {
            account_id: "bank-id",
            amount: "50.00",
            currency: "BRL",
          },
          to: { account_id: "ledger-id", currency: "BRL" },
        },
      },
      operation: "Create Kraken BRL deposit",
    });
    expect(JSON.stringify(createCall?.[2])).not.toContain("network");
    expect(depositReads).toBe(3);
    expect(instructionReads).toBe(2);
    expect(write.mock.calls.at(-1)?.[0]).toContain('"status": "completed"');
    expect(write.mock.calls.at(-1)?.[0]).toContain('"balance_after": "50"');
    write.mockRestore();
    errorWrite.mockRestore();
  });

  test("stops when Staging returns payable-looking instructions", async () => {
    const request = mock(async (method: string, path: string, _options?: unknown) => {
      if (path === "/v1/accounts/ledger-id") {
        return response({ data: ledgerBefore });
      }
      if (path === "/v1/accounts/bank-id") {
        return response({ data: sourceBank });
      }
      if (method === "POST") {
        return response({ data: { id: "deposit-id", desired, steps: [] } }, 201);
      }
      if (path.endsWith("/instructions")) {
        return response({
          data: {
            to_account: {
              bank_account_number: "123456789",
              bank_identifier_code: "real-pix-key",
            },
            amount: "50",
            currency: "BRL",
          },
        });
      }
      return response({ data: planned });
    });

    await expect(
      runKrakenDeposit(runtime(request), {
        sourceBankId: "bank-id",
        krakenLedgerId: "ledger-id",
        amount: "50",
        pollIntervalSeconds: 0.001,
        timeoutSeconds: 1,
      }),
    ).rejects.toThrow("Expected non-payable Staging Kraken PIX instructions");
  });

  test("resumes a completed Tesser deposit without creating another one", async () => {
    const request = mock(async (method: string, path: string, _options?: unknown) => {
      if (path === "/v1/accounts/ledger-id") {
        return response({
          data: {
            ...ledgerBefore,
            assets: ledgerBefore.assets.map((asset) =>
              asset.currency === "BRL"
                ? { ...asset, available_balance: "50" }
                : asset,
            ),
          },
        });
      }
      if (path === "/v1/treasury/deposits/deposit-id") {
        return response({ data: completed });
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    await runKrakenDeposit(runtime(request), {
      depositId: "deposit-id",
      pollIntervalSeconds: 0.001,
      timeoutSeconds: 1,
    });

    expect(request.mock.calls.some((call) => call[0] === "POST")).toBeFalse();
    expect(
      request.mock.calls.some((call) => String(call[1]).endsWith("/instructions")),
    ).toBeFalse();
    expect(write.mock.calls.at(-1)?.[0]).toContain('"deposit_id": "deposit-id"');
    write.mockRestore();
    errorWrite.mockRestore();
  });
});

function runtime(request: ReturnType<typeof mock>): Runtime {
  return {
    environment: {} as Environment,
    interaction: new NonInteractiveInteraction(),
    output: new Output("json", false),
    client: {
      configuration: { baseUrl: "https://staging.example" },
      authenticate: mock(async () => "access-token"),
      request,
    } as unknown as TesserClient,
  };
}

function response(body: unknown, status = 200): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 201 ? "Created" : "OK",
    url: "https://staging.example",
    body,
    headers: {},
  };
}
