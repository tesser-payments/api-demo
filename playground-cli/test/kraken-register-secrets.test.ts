import { describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Environment } from "../src/config.ts";
import type { HttpResponse, TesserClient } from "../src/http.ts";
import {
  NonInteractiveInteraction,
  type Choice,
  type Interaction,
} from "../src/interaction.ts";
import type { KrakenFundingApi } from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import { runKrakenRegisterSecrets } from "../src/workflows/kraken-register-secrets.ts";

const cadInstructions = {
  methodId: "cad-method",
  bankName: "Kraken Bank",
  bankAccountNumber: "123456789",
  bankCodeType: "TRANSIT",
  bankIdentifierCode: "00011",
  bankSwiftCode: "KRAKCA01",
  beneficiaryName: "Payward Canada Inc.",
  beneficiaryAddress: "1 Canada Street",
  trackingReference: "CAD-REFERENCE",
};

const ledger = {
  id: "ledger-id",
  type: "ledger",
  provider: "KRAKEN",
  is_managed: true,
  assets: ["BRL", "CAD", "USDC", "USDT"].map((currency) => ({
    currency,
    network: null,
    available_balance: "0",
  })),
};

describe("Kraken secret registration", () => {
  test("registers a normalized CAD instructions file without BRL instructions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kraken-register-"));
    const instructionsPath = join(directory, "cad.json");
    writeFileSync(instructionsPath, JSON.stringify(cadInstructions));
    const request = mock(async (method: string, path: string, _options?: unknown) => {
      if (method === "GET") {
        const accountList = request.mock.calls.filter(
          (call) => call[0] === "GET",
        ).length;
        return response({ data: accountList === 1 ? [] : [ledger] });
      }
      return response({ success: true, masked_value: "****" });
    });
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    await runKrakenRegisterSecrets(runtime(request), {
      cadInstructionsFile: instructionsPath,
    });

    const registrationCall = request.mock.calls.find(
      (call) => call[0] === "POST",
    );
    expect(registrationCall?.[1]).toBe("/v1/organizations/secrets");
    expect(registrationCall?.[2]).toEqual({
      headers: { "x-api-client": "true" },
      body: {
        provider: "KRAKEN",
        key: "KRAKEN_CREDENTIALS",
        value: {
          apiKey: "api-key",
          apiSecret: "c2VjcmV0",
          depositInstructions: { CAD: cadInstructions },
        },
      },
      operation: "Register Kraken secrets",
    });
    expect(JSON.stringify(registrationCall?.[2])).not.toContain(
      "depositInstructions\":{\"BRL",
    );
    expect(write.mock.calls.at(-1)?.[0]).toContain('"provider": "KRAKEN"');
    expect(JSON.stringify(errorWrite.mock.calls)).not.toContain("123456789");
    write.mockRestore();
    errorWrite.mockRestore();
  });

  test("collects UI instructions for the first CAD method and registers them", async () => {
    const request = mock(async (method: string, _path: string, _options?: unknown) => {
      if (method === "GET") {
        const accountList = request.mock.calls.filter(
          (call) => call[0] === "GET",
        ).length;
        return response({ data: accountList === 1 ? [] : [ledger] });
      }
      return response({ success: true, masked_value: "****" });
    });
    const fundingRequest = mock(async (
      _method: string,
      _path: string,
      _request: unknown,
    ) => ({
      methods: [
        {
          asset: { name: "CAD" },
          method_id: "cad-method",
          method_name: "Canadian domestic wire",
        },
        {
          asset: { name: "CAD" },
          method_id: "second-method",
          method_name: "SWIFT",
        },
      ],
    }));
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorWrite = spyOn(process.stderr, "write").mockImplementation(
      () => true,
    );

    await runKrakenRegisterSecrets(
      runtime(request, new CadInstructionsInteraction()),
      {},
      { request: fundingRequest } as KrakenFundingApi,
    );

    expect(fundingRequest.mock.calls[0]?.[1]).toBe(
      "/funding/v1/methods/deposit",
    );
    expect(fundingRequest).toHaveBeenCalledTimes(1);
    const registrationCall = request.mock.calls.find(
      (call) => call[0] === "POST",
    );
    expect(registrationCall?.[2]).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({
          value: expect.objectContaining({
            depositInstructions: { CAD: cadInstructions },
          }),
        }),
      }),
    );
    expect(JSON.stringify(errorWrite.mock.calls)).not.toContain("123456789");
    write.mockRestore();
    errorWrite.mockRestore();
  });
});

function runtime(
  request: ReturnType<typeof mock>,
  interaction: Interaction = new NonInteractiveInteraction(),
): Runtime {
  return {
    environment: {
      KRAKEN_API_KEY: "api-key",
      KRAKEN_API_SECRET: "c2VjcmV0",
    } as Environment,
    interaction,
    output: new Output("json", false),
    client: {
      configuration: { baseUrl: "https://staging.example" },
      request,
    } as unknown as TesserClient,
  };
}

function response(body: unknown): HttpResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    url: "https://staging.example",
    body,
    headers: {},
  };
}

class CadInstructionsInteraction implements Interaction {
  readonly interactive = true;

  async text(
    label: string,
    value?: string,
    defaultValue?: string,
  ): Promise<string> {
    const values: Record<string, string> = {
      "CAD bank name": cadInstructions.bankName,
      "CAD bank code type": cadInstructions.bankCodeType,
      "CAD bank identifier code": cadInstructions.bankIdentifierCode,
      "CAD beneficiary name": cadInstructions.beneficiaryName,
    };
    const resolved = value?.trim() || defaultValue?.trim() || values[label];
    if (!resolved) throw new Error(`${label} has no default`);
    return resolved;
  }

  async optionalText(
    label: string,
    defaultValue?: string,
  ): Promise<string | undefined> {
    const values: Record<string, string> = {
      "CAD bank SWIFT code": cadInstructions.bankSwiftCode,
      "CAD beneficiary address": cadInstructions.beneficiaryAddress,
      "CAD tracking reference": cadInstructions.trackingReference,
    };
    return defaultValue ?? values[label];
  }

  async secret(label: string, value?: string): Promise<string> {
    const resolved = value ?? (
      label === "CAD bank account number"
        ? cadInstructions.bankAccountNumber
        : undefined
    );
    if (!resolved) throw new Error(`${label} has no default`);
    return resolved;
  }

  async choose<T>(_label: string, choices: Choice<T>[]): Promise<T> {
    return choices[0]!.value;
  }

  async confirm(): Promise<boolean> {
    return true;
  }

  async approve(): Promise<void> {}
}
