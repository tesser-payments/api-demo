import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { authenticate } from "../client.ts";
import { throwawayApiKey } from "../testing/api-key.ts";
import type { Payment, Step } from "../types.ts";
import { createWalletWithKotlinSdk, KOTLIN_SIGNER, SIGNING_VARIABLES, signWithKotlinSdk } from "./kotlin-signer.ts";

const leg = { account_id: null, amount: null, currency: null, network: null };

const step: Step = {
  id: "step-1",
  step_sequence: 1,
  step_type: "transfer",
  estimated: {
    from: { account_id: "source-wallet", amount: "0.1", currency: "USDC", network: "POLYGON_AMOY" },
    to: { account_id: "beneficiary-wallet", amount: "0.1", currency: "USDC", network: "POLYGON_AMOY" },
  },
  actual: { from: leg, to: leg },
  status: "signature_requested",
  unsigned_transaction: "0x02f00189",
  created_at: "",
  updated_at: "",
};

const payment = { id: "payment-1" } as Payment;

let fetchSpy: ReturnType<typeof spyOn>;
const requests: { method: string; path: string; body?: unknown }[] = [];
let publicKey: string;

const decodeSignature = (signature: string) => {
  const envelope = JSON.parse(atob(signature)) as { body: string; stamp: string };
  const stamp = JSON.parse(Buffer.from(envelope.stamp, "base64url").toString()) as { publicKey: string };
  return { body: JSON.parse(envelope.body), rawBody: envelope.body, stampPublicKey: stamp.publicKey };
};

describe("signWithKotlinSdk on an incomplete step", () => {
  test("fails naming the step when it has no transaction to sign", async () => {
    await expect(signWithKotlinSdk({ ...step, unsigned_transaction: null }, payment)).rejects.toThrow(
      "Step step-1 has no unsigned transaction",
    );
  });

  test("fails naming the step when it has no source network", async () => {
    const withoutNetwork = { ...step, estimated: { ...step.estimated, from: { ...step.estimated.from, network: null } } };
    await expect(signWithKotlinSdk(withoutNetwork, payment)).rejects.toThrow("Step step-1 has no source network");
  });
});

// Skipped only while the signer isn't built; CI always builds it first.
const signerBuilt = await Bun.file(KOTLIN_SIGNER).exists();

describe.skipIf(!signerBuilt && !process.env.CI)("the Kotlin signer", () => {
  beforeEach(async () => {
    requests.length = 0;
    process.env.TESSER_CLIENT_ID ||= "test";
    process.env.TESSER_CLIENT_SECRET ||= "test";
    const keys = await throwawayApiKey();
    publicKey = keys.apiPublicKey;
    process.env.SIGNING_PUBLIC_KEY = keys.apiPublicKey;
    process.env.SIGNING_PRIVATE_KEY = keys.apiPrivateKey;
    process.env.SIGNING_ENCLAVE_ID = "sub-org-1";

    fetchSpy = spyOn(globalThis, "fetch");
    fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers.Authorization) return Response.json({ access_token: "t" });
      const method = init?.method ?? "GET";
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      requests.push({ method, path: new URL(String(url)).pathname, ...(body && { body }) });
      if (method === "POST") {
        return Response.json({ data: { id: "new-wallet", name: body.name, type: body.type, is_managed: true } }, { status: 201 });
      }
      return Response.json({ data: { id: "source-wallet", crypto_wallet_address: "0x00000000000000000000000000000000000000a1" } });
    });
    await authenticate();
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const name of SIGNING_VARIABLES) delete process.env[name];
  });

  test("signs the step's transaction with the source wallet's address from the API", async () => {
    const signature = await signWithKotlinSdk(step, payment);

    expect(requests).toEqual([{ method: "GET", path: "/v1/accounts/source-wallet" }]);
    const { body, stampPublicKey } = decodeSignature(signature);
    expect(body.type).toBe("ACTIVITY_TYPE_SIGN_TRANSACTION_V2");
    expect(body.organizationId).toBe("sub-org-1");
    expect(body.parameters.unsignedTransaction).toBe("0x02f00189");
    expect(body.parameters.signWith).toBe("0x00000000000000000000000000000000000000a1");
    expect(stampPublicKey).toBe(publicKey);
  });

  test("creates a managed wallet with the creation the Kotlin SDK stamps for its name", async () => {
    const wallet = await createWalletWithKotlinSdk("E2E outbound run-1");

    expect(wallet.id).toBe("new-wallet");
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/accounts/wallets",
        body: { name: "E2E outbound run-1", type: "stablecoin_ethereum", is_managed: true, signature: expect.any(String) },
      },
    ]);
    const { body, rawBody, stampPublicKey } = decodeSignature((requests[0]!.body as { signature: string }).signature);
    expect(body.type).toStartWith("ACTIVITY_TYPE_CREATE_WALLET");
    expect(body.organizationId).toBe("sub-org-1");
    expect(rawBody).toContain('"E2E outbound run-1"');
    expect(stampPublicKey).toBe(publicKey);
  });

  test("fails with the signer's reason when it can't sign", async () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    await expect(signWithKotlinSdk(step, payment)).rejects.toThrow("SIGNING_PRIVATE_KEY is not set");
  });
});
