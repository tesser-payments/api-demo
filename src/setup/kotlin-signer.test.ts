import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
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

// Skipped while the signer isn't built; CI runs this file again once it is, with REQUIRE_KOTLIN_SIGNER set.
const signerBuilt = await Bun.file(KOTLIN_SIGNER).exists();

// What Tesser's unsigned-payload endpoint serves: the creation the SDK must stamp unchanged.
const servedCreation = JSON.stringify({
  type: "ACTIVITY_TYPE_CREATE_WALLET_ACCOUNTS",
  timestampMs: "1",
  organizationId: "sub-org-1",
  parameters: {
    walletId: "master-wallet",
    accounts: [
      {
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/44'/60'/1'/0/2",
        addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        name: "E2E outbound run-1",
      },
    ],
  },
});
const payloadRequests: URL[] = [];
let tesser: ReturnType<typeof Bun.serve>;
// Restored after each test, so a developer's own values survive the run.
const overwritten = [...SIGNING_VARIABLES, "TESSER_BASE_URL"];
const saved = new Map(overwritten.map((name) => [name, process.env[name]]));

describe.skipIf(!signerBuilt && !process.env.REQUIRE_KOTLIN_SIGNER)("the Kotlin signer", () => {
  // The JVM calls Tesser over the network, so it gets a real local server rather than the fetch spy.
  beforeAll(() => {
    tesser = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v1/accounts/wallets/unsigned-payload") return new Response("Not found", { status: 404 });
        payloadRequests.push(url);
        return Response.json({ data: { body: servedCreation } });
      },
    });
  });
  afterAll(() => tesser.stop());

  beforeEach(async () => {
    requests.length = 0;
    payloadRequests.length = 0;
    process.env.TESSER_BASE_URL = `http://127.0.0.1:${tesser.port}`;
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
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
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

  test("creates a managed wallet with the creation Tesser builds for its name, stamped by the Kotlin SDK", async () => {
    const wallet = await createWalletWithKotlinSdk("E2E outbound run-1");

    expect(wallet.id).toBe("new-wallet");
    expect(payloadRequests.map((url) => url.searchParams.get("name"))).toEqual(["E2E outbound run-1"]);
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/accounts/wallets",
        body: { name: "E2E outbound run-1", type: "stablecoin_ethereum", is_managed: true, signature: expect.any(String) },
      },
    ]);
    const { rawBody, stampPublicKey } = decodeSignature((requests[0]!.body as { signature: string }).signature);
    expect(rawBody).toBe(servedCreation);
    expect(stampPublicKey).toBe(publicKey);
  });

  test("fails with the signer's reason when it can't sign", async () => {
    delete process.env.SIGNING_PRIVATE_KEY;
    await expect(signWithKotlinSdk(step, payment)).rejects.toThrow("SIGNING_PRIVATE_KEY is not set");
  });
});
