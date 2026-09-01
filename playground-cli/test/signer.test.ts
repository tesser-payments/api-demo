import { beforeAll, describe, expect, mock, test } from "bun:test";

const stamp = mock(async () => ({
  stampHeaderName: "X-Stamp",
  stampHeaderValue: "stamp-value",
}));

beforeAll(() => {
  mock.module("@turnkey/api-key-stamper", () => ({
    ApiKeyStamper: class {
      stamp = stamp;
    },
  }));
});

describe("local signing", () => {
  test("creates the expected Turnkey signature envelope", async () => {
    const { signStep } = await import("../src/signer.ts");
    const signature = await signStep(
      { publicKey: "public", privateKey: "private", enclaveId: "enclave" },
      {
        unsignedTransaction: "0x1234",
        signWith: "0xabc",
        network: "BASE_SEPOLIA",
      },
    );
    const envelope = JSON.parse(Buffer.from(signature, "base64").toString("utf8"));
    const body = JSON.parse(envelope.body);

    expect(envelope.stamp).toBe("stamp-value");
    expect(body.type).toBe("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
    expect(body.organizationId).toBe("enclave");
    expect(body.parameters).toEqual({
      signWith: "0xabc",
      unsignedTransaction: "0x1234",
      type: "TRANSACTION_TYPE_ETHEREUM",
    });
  });

  test("rejects unsupported networks before stamping", async () => {
    const { signStep } = await import("../src/signer.ts");
    await expect(
      signStep(
        { publicKey: "public", privateKey: "private", enclaveId: "enclave" },
        { unsignedTransaction: "tx", signWith: "address", network: "UNKNOWN" },
      ),
    ).rejects.toThrow("Unsupported signing network");
  });
});
