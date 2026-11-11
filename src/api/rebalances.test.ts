import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { authenticate } from "../client.ts";
import { createRebalance, getRebalance, submitRebalanceStepSignature } from "./rebalances.ts";

let logSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;
const requests: { method: string; path: string; body?: unknown; key?: string }[] = [];

// Auth, then every request is recorded and answered with `response`.
async function serve(response: { status: number; body: unknown }) {
  fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers.Authorization) return Response.json({ access_token: "t" });
    requests.push({
      method: init?.method ?? "GET",
      path: new URL(String(url)).pathname,
      ...(init?.body && { body: JSON.parse(String(init.body)) }),
      ...(headers["Idempotency-Key"] && { key: headers["Idempotency-Key"] }),
    });
    return Response.json(response.body, { status: response.status });
  });
  await authenticate();
}

beforeEach(() => {
  requests.length = 0;
  process.env.TESSER_CLIENT_ID ||= "test";
  process.env.TESSER_CLIENT_SECRET ||= "test";
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => {
  logSpy.mockRestore();
  fetchSpy.mockRestore();
});

describe("createRebalance", () => {
  test("asks to move the amount between the two wallets on the same network and returns the rebalance", async () => {
    await serve({ status: 201, body: { data: { id: "r1", balance_status: "unreserved", steps: [] } } });

    const rebalance = await createRebalance({
      fromAccountId: "source-wallet",
      toAccountId: "destination-wallet",
      amount: "0.5",
      currency: "USDC",
      network: "POLYGON_AMOY",
      reference: "ref-1",
    });

    expect(rebalance.id).toBe("r1");
    expect(rebalance.balance_status).toBe("unreserved");
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/treasury/rebalances",
        body: {
          organization_reference_id: "ref-1",
          desired: {
            from: { account_id: "source-wallet", amount: "0.5", currency: "USDC", network: "POLYGON_AMOY" },
            to: { account_id: "destination-wallet", currency: "USDC", network: "POLYGON_AMOY" },
          },
        },
        key: expect.any(String),
      },
    ]);
  });
});

describe("getRebalance", () => {
  test("reads the rebalance by id", async () => {
    await serve({ status: 200, body: { data: { id: "r1" } } });
    expect((await getRebalance("r1")).id).toBe("r1");
    expect(requests).toEqual([{ method: "GET", path: "/v1/treasury/rebalances/r1" }]);
  });
});

describe("submitRebalanceStepSignature", () => {
  const signed = { rebalanceId: "r1", stepId: "s1", signature: "signature-secret", idempotencyKey: "key-1" };

  test("posts the signature to the rebalance step's sign endpoint under the caller's key", async () => {
    await serve({ status: 200, body: { data: {} } });
    await submitRebalanceStepSignature(signed);
    expect(requests).toEqual([
      { method: "POST", path: "/v1/treasury/rebalances/r1/steps/s1/sign", body: { signature: "signature-secret" }, key: "key-1" },
    ]);
  });

  test("keeps the signature out of the error when the platform refuses it", async () => {
    await serve({ status: 400, body: { errors: [{ error_code: "treasury-3028", error_message: "refused" }] } });

    const error = (await submitRebalanceStepSignature(signed).catch((e) => e)) as Error;

    expect(error.message).toContain("/v1/treasury/rebalances/r1/steps/s1/sign failed (400)");
    expect(error.message).not.toContain("signature-secret");
  });
});
