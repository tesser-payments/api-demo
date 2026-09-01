import { describe, expect, test } from "bun:test";
import { sanitize } from "../src/output.ts";

describe("output sanitization", () => {
  test("redacts secrets recursively", () => {
    expect(
      sanitize({
        authorization: "Bearer token",
        nested: {
          client_secret: "secret",
          signature: "signature",
          unsigned_transaction: "0x123456",
        },
      }),
    ).toEqual({
      authorization: "<redacted>",
      nested: {
        client_secret: "<redacted>",
        signature: "<redacted>",
        unsigned_transaction: "<unsigned-transaction:8 chars>",
      },
    });
  });

  test("masks bank account numbers", () => {
    expect(sanitize({ bank_account_number: "1234567890" })).toEqual({
      bank_account_number: "••••••7890",
    });
  });
});
