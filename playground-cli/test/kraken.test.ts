import { describe, expect, mock, spyOn, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import { UsageError } from "../src/errors.ts";
import {
  NonInteractiveInteraction,
  type Choice,
  type Interaction,
} from "../src/interaction.ts";
import {
  createKrakenFundingSignature,
  createKrakenSpotSignature,
  encodeKrakenFundingQuery,
  KrakenFundingClient,
  KrakenNonce,
  KrakenSpotClient,
  type KrakenFundingApi,
} from "../src/kraken.ts";
import { Output } from "../src/output.ts";
import { runKraken, type KrakenRuntime } from "../src/workflows/kraken.ts";

describe("Kraken Funding API", () => {
  test("encodes nested Funding Beta query values", () => {
    expect(
      encodeKrakenFundingQuery({
        asset: { class: "currency", name: "BRL" },
        account_id: "account-1",
        limit: 500,
      }),
    ).toBe(
      "asset%5Bclass%5D=currency&asset%5Bname%5D=BRL&account_id=account-1&limit=500",
    );
  });

  test("signs the query path, nonce, and compact JSON body", () => {
    expect(
      createKrakenFundingSignature(
        "/funding/v1/deposit/address?account_id=account-1",
        "1616492376594",
        '{"method_id":"method-1"}',
        "c2VjcmV0",
      ),
    ).toBe(
      "c3TmIlFJb0SNggFtvDonSl6YEMCRoKh85FK6+VE+6iceGvcoW2y84wVKWRJpelpgW6AjbvQJrDCL8y4P6nldhA==",
    );
  });

  test("sends the documented funding-method parameters and authentication headers", async () => {
    const request = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"methods":[]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new KrakenFundingClient(
      {
        apiKey: "api-key",
        apiSecret: "c2VjcmV0",
        baseUrl: "https://api.kraken.com",
        timeoutSeconds: 1,
      },
      new Output("json", false),
      request as unknown as typeof fetch,
    );

    await client.request("GET", "/funding/v1/methods/deposit", {
      query: {
        asset: { class: "currency", name: "CAD" },
        limit: 500,
      },
      operation: "List methods",
    });

    const [url, init] = request.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const signedPath = "/funding/v1/methods/deposit?asset%5Bclass%5D=currency&asset%5Bname%5D=CAD&limit=500";
    const nonce = headers.get("api-nonce")!;
    expect(url).toBe(`https://api.kraken.com${signedPath}`);
    expect(headers.get("api-key")).toBe("api-key");
    expect(headers.get("api-sign")).toBe(
      createKrakenFundingSignature(signedPath, nonce, "", "c2VjcmV0"),
    );
  });
});

describe("Kraken Spot API", () => {
  test("keeps nonces increasing within the process", () => {
    const now = spyOn(Date, "now").mockReturnValue(1000);
    const nonce = new KrakenNonce();

    expect(nonce.next()).toBe("1000000");
    expect(nonce.next()).toBe("1000001");
    now.mockRestore();
  });

  test("signs the private path and JSON payload", async () => {
    const request = mock(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{"error":[],"result":{"ZUSD":{"balance":"10"}}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new KrakenSpotClient(
      {
        apiKey: "api-key",
        apiSecret: "c2VjcmV0",
        baseUrl: "https://api.kraken.com",
        timeoutSeconds: 1,
      },
      new Output("json", false),
      request as unknown as typeof fetch,
      new KrakenNonce(),
    );

    await client.request("POST", "/0/private/BalanceEx", {
      operation: "Get balances",
    });

    const [url, init] = request.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const body = String(init?.body);
    const nonce = JSON.parse(body).nonce;
    expect(typeof nonce).toBe("number");
    expect(url).toBe("https://api.kraken.com/0/private/BalanceEx");
    expect(headers.get("api-key")).toBe("api-key");
    expect(headers.get("api-sign")).toBe(
      createKrakenSpotSignature("/0/private/BalanceEx", String(nonce), body, "c2VjcmV0"),
    );
  });
});

describe("Kraken BRL/PIX workflow", () => {
  test("asks for and returns an existing successful deposit without requesting new funding", async () => {
    const existingDeposit = {
      deposit_id: "existing-deposit",
      method_id: "pix-method",
      status: "success",
      create_time: "2026-09-04T12:00:00Z",
      amount: { asset: { class: "currency", name: "BRL" }, amount: "50" },
    };
    const responses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "BRL" },
            method_id: "pix-method",
            method_name: "Pix (PayAmigo)",
          },
        ],
      },
      { deposits: [existingDeposit] },
    ];
    const request = mock(async () => responses.shift()!);
    const interaction = new ExistingDepositInteraction();

    const result = await runKraken(
      runtime(interaction),
      {
        methodId: "pix-method",
        embedded: true,
        allowExistingDeposit: true,
      },
      { request } as KrakenFundingApi,
    );

    expect(result).toEqual(existingDeposit);
    expect(request).toHaveBeenCalledTimes(2);
    expect(interaction.choiceLabels).toEqual([
      "Kraken deposit source",
      "Select the successful Kraken BRL deposit",
    ]);
  });

  test("claims fiat instructions and waits for the new deposit to succeed", async () => {
    const oldDeposit = {
      deposit_id: "old-deposit",
      method_id: "pix-method",
      status: "success",
    };
    const pendingDeposit = {
      deposit_id: "new-deposit",
      method_id: "pix-method",
      network_id: "pix-network",
      status: "pending",
      amount: { asset: { class: "currency", name: "USD" }, amount: "9.95" },
      fee: { asset: { class: "currency", name: "BRL" }, amount: "0.05" },
      create_time: "2026-09-02T12:00:00Z",
    };
    const responses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "BRL" },
            method_id: "pix-method",
            method_name: "PIX",
            minimum_amount: "50",
            deposit: { address_generation: { status: "unlimited" } },
          },
        ],
      },
      { deposits: [oldDeposit] },
      { address_details: { fiat: { pix_code: "pix-code" } } },
      { deposits: [pendingDeposit] },
      { deposits: [{ ...pendingDeposit, status: "success" }] },
    ];
    const request = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: unknown,
      ) => responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);
    const interaction = new RecordingInteraction();

    await runKraken(
      runtime(interaction),
      { pollIntervalSeconds: 0.001, timeoutSeconds: 1 },
      { request } as KrakenFundingApi,
    );

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[0]?.[1]).toBe("/funding/v1/methods/deposit");
    expect(request.mock.calls[0]?.[2]).toEqual({
      query: {
        asset: { class: "currency", name: "BRL" },
        limit: 500,
      },
      operation: "List Kraken deposit funding methods",
    });
    expect(request.mock.calls[2]?.[0]).toBe("PUT");
    expect(request.mock.calls[2]?.[1]).toBe("/funding/v1/deposit/address");
    expect(interaction.choiceLabels).toEqual(["Select the Kraken BRL deposit method"]);
    expect(standardOutput.mock.calls.at(-1)?.[0]).toContain('"status": "success"');
    expect(errorOutput.mock.calls.some((call) => String(call[0]).includes("pix-code"))).toBeTrue();
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("stops when the claim response does not contain fiat instructions", async () => {
    const responses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "BRL" },
            method_id: "pix-method",
            method_name: "PIX",
            deposit: { address_generation: { status: "unlimited" } },
          },
        ],
      },
      {},
      { address_details: { crypto: { address: "unexpected-address" } } },
    ];
    const request = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: unknown,
      ) => responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runKraken(
        runtime(),
        { pollIntervalSeconds: 0.001, timeoutSeconds: 1 },
        { request } as KrakenFundingApi,
      ),
    ).rejects.toBeInstanceOf(UsageError);

    expect(request).toHaveBeenCalledTimes(3);
    expect(errorOutput.mock.calls.some((call) => String(call[0]).includes("unexpected-address"))).toBeTrue();
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("uses Kraken Web when the funding method cannot generate deposit instructions", async () => {
    const responses: Record<string, unknown>[] = [
      {
        methods: [
          {
            asset: { class: "currency", name: "BRL" },
            method_id: "wire-method",
            method_name: "Wire Transfer",
            deposit: {},
          },
        ],
      },
      {},
      {
        deposits: [
          {
            deposit_id: "new-deposit",
            method_id: "wire-method",
            status: "success",
          },
        ],
      },
    ];
    const request = mock(
      async (
        _method: "GET" | "POST" | "PUT" | "DELETE",
        _path: string,
        _request: unknown,
      ) => responses.shift()!,
    );
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);
    const interaction = new ManualPixInteraction();

    await runKraken(
      runtime(interaction, new Output("json", true)),
      { pollIntervalSeconds: 0.001, timeoutSeconds: 1 },
      { request } as KrakenFundingApi,
    );

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls.some((call) => call[0] === "PUT")).toBeFalse();
    expect(interaction.readinessChecks).toBe(2);
    const manualInstruction = errorOutput.mock.calls.find((call) =>
      String(call[0]).includes("https://www.kraken.com/c"),
    );
    expect(manualInstruction).toBeDefined();
    expect(String(manualInstruction?.[0])).toContain("Complete the BRL deposit");
    expect(String(manualInstruction?.[0])).toContain("Wire Transfer");
    expect(String(manualInstruction?.[0])).not.toContain('"event"');
    expect(errorOutput.mock.calls.some((call) => String(call[0]).includes("kraken.deposit.detected"))).toBeFalse();
    expect(standardOutput).not.toHaveBeenCalled();
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });
});

class RecordingInteraction extends NonInteractiveInteraction {
  readonly choiceLabels: string[] = [];

  override async choose<T>(label: string, choices: Choice<T>[]): Promise<T> {
    this.choiceLabels.push(label);
    return super.choose(label, choices);
  }
}

class ExistingDepositInteraction implements Interaction {
  readonly interactive = true;
  readonly choiceLabels: string[] = [];

  async text(label: string, value?: string, defaultValue?: string): Promise<string> {
    const resolved = value?.trim() || defaultValue?.trim();
    if (!resolved) throw new UsageError(`${label} is required`);
    return resolved;
  }

  async optionalText(_label: string, defaultValue?: string): Promise<string | undefined> {
    return defaultValue;
  }

  async secret(label: string, value?: string): Promise<string> {
    if (!value) throw new UsageError(`${label} is required`);
    return value;
  }

  async choose<T>(label: string, choices: Choice<T>[]): Promise<T> {
    this.choiceLabels.push(label);
    return choices[0]!.value;
  }

  async confirm(_label: string, defaultValue = false): Promise<boolean> {
    return defaultValue;
  }

  async approve(): Promise<void> {}
}

class ManualPixInteraction implements Interaction {
  readonly interactive = true;
  readinessChecks = 0;

  async text(label: string, value?: string, defaultValue?: string): Promise<string> {
    const resolved = value?.trim() || defaultValue?.trim();
    if (!resolved) throw new UsageError(`${label} is required`);
    return resolved;
  }

  async optionalText(_label: string, defaultValue?: string): Promise<string | undefined> {
    return defaultValue;
  }

  async secret(label: string, value?: string): Promise<string> {
    if (!value) throw new UsageError(`${label} is required`);
    return value;
  }

  async choose<T>(_label: string, choices: Choice<T>[]): Promise<T> {
    return choices[0]!.value;
  }

  async confirm(): Promise<boolean> {
    this.readinessChecks += 1;
    return this.readinessChecks > 1;
  }

  async approve(): Promise<void> {}
}

function runtime(
  interaction: Interaction = new NonInteractiveInteraction(),
  output = new Output("json", false),
): KrakenRuntime {
  return {
    environment: {
      KRAKEN_API_KEY: "api-key",
      KRAKEN_API_SECRET: "c2VjcmV0",
    } as Environment,
    interaction,
    output,
  };
}
