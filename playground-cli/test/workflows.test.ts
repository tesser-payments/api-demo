import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import type { HttpResponse, TesserClient } from "../src/http.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import { runPayment } from "../src/workflows/payment.ts";
import { runWithdrawal } from "../src/workflows/withdrawal.ts";
import { runRebalance } from "../src/workflows/rebalance.ts";

function response(data: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://sandbox.example",
    body: { data },
    headers: {},
  };
}

function runtimeFor(
  responses: HttpResponse[],
  environment: Environment = {},
): { runtime: Runtime; request: ReturnType<typeof mock> } {
  const request = mock(async () => responses.shift()!);
  const client = {
    configuration: {
      baseUrl: "https://sandbox.example",
      authUrl: "https://auth.example/oauth/token",
    },
    authenticate: mock(async () => "token"),
    request,
  } as unknown as TesserClient;
  return {
    runtime: {
      environment,
      interaction: new NonInteractiveInteraction(),
      output: new Output("json", false),
      client,
    },
    request,
  };
}

describe("resumable workflows", () => {
  test("resumes an already signed payment and polls to completion", async () => {
    const submitted = {
      id: "payment-id",
      risk_status: "automatically_approved",
      steps: [
        {
          id: "step-id",
          step_sequence: 1,
          provider_key: "turnkey",
          status: "submitted",
        },
      ],
    };
    const completed = {
      ...submitted,
      steps: [{ ...submitted.steps[0], status: "completed" }],
    };
    const { runtime, request } = runtimeFor([response(submitted), response(completed)]);
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await runPayment(runtime, undefined, {
      paymentId: "payment-id",
      pollIntervalSeconds: 0.001,
      timeoutSeconds: 1,
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(write.mock.calls.at(-1)?.[0]).toContain('"id": "payment-id"');
    write.mockRestore();
  });

  test("validates withdrawal configuration without API calls", async () => {
    const environment = {
      SIGNING_PUBLIC_KEY: "public",
      SIGNING_PRIVATE_KEY: "private",
      SIGNING_ENCLAVE_ID: "enclave",
    };
    const { runtime, request } = runtimeFor([], environment);
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await runWithdrawal(runtime, { validateOnly: true });

    expect(request).not.toHaveBeenCalled();
    expect(write.mock.calls.at(-1)?.[0]).toContain('"valid": true');
    write.mockRestore();
  });

  test("resumes an already signed withdrawal and polls to completion", async () => {
    const environment = {
      SIGNING_PUBLIC_KEY: "public",
      SIGNING_PRIVATE_KEY: "private",
      SIGNING_ENCLAVE_ID: "enclave",
    };
    const submitted = {
      id: "withdrawal-id",
      balance_status: "reserved",
      steps: [
        {
          id: "step-id",
          step_sequence: 1,
          provider_key: "turnkey",
          status: "submitted",
        },
      ],
    };
    const completed = {
      ...submitted,
      steps: [{ ...submitted.steps[0], status: "completed" }],
    };
    const { runtime, request } = runtimeFor([response(submitted), response(submitted), response(completed)], environment);
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await runWithdrawal(runtime, {
      withdrawalId: "withdrawal-id",
      pollIntervalSeconds: 0.001,
      timeoutSeconds: 1,
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.at(-1)?.[0]).toContain('"id": "withdrawal-id"');
    write.mockRestore();
  });

  test("validates rebalance configuration without API calls", async () => {
    const environment = {
      SIGNING_PUBLIC_KEY: "public",
      SIGNING_PRIVATE_KEY: "private",
      SIGNING_ENCLAVE_ID: "enclave",
    };
    const { runtime, request } = runtimeFor([], environment);
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await runRebalance(runtime, { validateOnly: true });

    expect(request).not.toHaveBeenCalled();
    expect(write.mock.calls.at(-1)?.[0]).toContain('"valid": true');
    write.mockRestore();
  });

  test("resumes an already submitted rebalance and polls to completion", async () => {
    const environment = {
      SIGNING_PUBLIC_KEY: "public",
      SIGNING_PRIVATE_KEY: "private",
      SIGNING_ENCLAVE_ID: "enclave",
    };
    const submitted = {
      id: "rebalance-id",
      balance_status: "reserved",
      steps: [
        {
          id: "step-id",
          step_sequence: 1,
          provider_key: "turnkey",
          status: "submitted",
          transaction_hash: "0xhash",
        },
      ],
    };
    const completed = {
      ...submitted,
      steps: [{ ...submitted.steps[0], status: "completed" }],
    };
    const { runtime, request } = runtimeFor(
      [response(submitted), response(submitted), response(completed)],
      environment,
    );
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await runRebalance(runtime, {
      rebalanceId: "rebalance-id",
      pollIntervalSeconds: 0.001,
      timeoutSeconds: 1,
    });

    expect(request).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.at(-1)?.[0]).toContain('"id": "rebalance-id"');
    write.mockRestore();
  });

  test("creates a wallet-to-OpenFX-ledger rebalance with the expected body", async () => {
    const environment = {
      SIGNING_PUBLIC_KEY: "public",
      SIGNING_PRIVATE_KEY: "private",
      SIGNING_ENCLAVE_ID: "enclave",
    };
    const sourceWallet = {
      id: "wallet-id",
      crypto_wallet_address: "0x1111111111111111111111111111111111111111",
      is_managed: true,
      tenant_id: null,
      counterparty_id: null,
      assets: [{ currency: "USDC", network: "BASE_SEPOLIA" }],
    };
    const destinationLedger = {
      id: "ledger-id",
      type: "ledger",
      provider: "OPENFX",
      tenant_id: null,
      counterparty_id: null,
    };
    const completed = {
      id: "rebalance-id",
      balance_status: "reserved",
      steps: [
        {
          id: "step-id",
          step_sequence: 1,
          provider_key: "turnkey",
          status: "completed",
        },
      ],
    };
    const { runtime, request } = runtimeFor(
      [
        response([sourceWallet]),
        response([destinationLedger]),
        response({ id: "rebalance-id", steps: [] }),
        response(completed),
        response(completed),
      ],
      environment,
    );
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await runRebalance(runtime, {
      amount: "100",
      fromCurrency: "USDC",
      fromNetwork: "BASE_SEPOLIA",
      toCurrency: "USD",
      organizationReferenceId: "rebalance-reference",
      pollIntervalSeconds: 0.001,
      timeoutSeconds: 1,
    });

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[2]).toEqual([
      "POST",
      "/v1/treasury/rebalances",
      {
        body: {
          organization_reference_id: "rebalance-reference",
          desired: {
            from: {
              account_id: "wallet-id",
              amount: "100",
              currency: "USDC",
              network: "BASE_SEPOLIA",
            },
            to: {
              account_id: "ledger-id",
              currency: "USD",
            },
          },
        },
        operation: "Create rebalance",
      },
    ]);
    write.mockRestore();
  });
});
