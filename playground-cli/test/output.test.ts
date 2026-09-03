import { describe, expect, spyOn, test } from "bun:test";
import { Output, sanitize } from "../src/output.ts";

describe("output sanitization", () => {
  test("redacts secrets recursively", () => {
    expect(
      sanitize({
        authorization: "Bearer token",
        nested: {
          client_secret: "secret",
          KRAKEN_API_KEY: "kraken-key",
          KRAKEN_API_SECRET: "kraken-secret",
          "API-Sign": "kraken-signature",
          signature: "signature",
          withdrawal_fee_token: "fee-token",
          unsigned_transaction: "0x123456",
        },
      }),
    ).toEqual({
      authorization: "<redacted>",
      nested: {
        client_secret: "<redacted>",
        KRAKEN_API_KEY: "<redacted>",
        KRAKEN_API_SECRET: "<redacted>",
        "API-Sign": "<redacted>",
        signature: "<redacted>",
        withdrawal_fee_token: "<redacted>",
        unsigned_transaction: "<unsigned-transaction:8 chars>",
      },
    });
  });

  test("masks bank account numbers", () => {
    expect(sanitize({ bank_account_number: "1234567890" })).toEqual({
      bank_account_number: "••••••7890",
    });
    expect(sanitize({ bankAccountNumber: "1234567890" })).toEqual({
      bankAccountNumber: "••••••7890",
    });
  });

  test("prints progress only in non-verbose human output", () => {
    const standardOutput = spyOn(process.stdout, "write").mockImplementation(() => true);
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    new Output("human", false).progress("workflow.validated", { value: "shown" });
    new Output("human", true).progress("workflow.validated", { value: "hidden" });
    new Output("json", true).progress("workflow.validated", { value: "hidden" });

    expect(standardOutput).toHaveBeenCalledTimes(1);
    expect(String(standardOutput.mock.calls[0]?.[0])).toContain("value=shown");
    expect(errorOutput).not.toHaveBeenCalled();
    standardOutput.mockRestore();
    errorOutput.mockRestore();
  });

  test("prints sanitized exchanges in verbose output", () => {
    const errorOutput = spyOn(process.stderr, "write").mockImplementation(() => true);

    new Output("human", true).exchange(
      "List methods",
      { method: "GET", path: "/funding/v1/methods/deposit", apiKey: "secret" },
      { status: 200, body: { methods: [] } },
    );

    expect(errorOutput).toHaveBeenCalledTimes(1);
    const exchange = JSON.parse(String(errorOutput.mock.calls[0]?.[0]));
    expect(exchange).toEqual({
      operation: "List methods",
      request: {
        method: "GET",
        path: "/funding/v1/methods/deposit",
        apiKey: "<redacted>",
      },
      response: { status: 200, body: { methods: [] } },
    });
    errorOutput.mockRestore();
  });
});
