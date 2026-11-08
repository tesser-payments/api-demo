import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { authenticate } from "../client.ts";
import { createPayment, simulateInbound } from "./payments.ts";

let logSpy: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;
const listed: string[] = [];

const inbound = (id: string, transaction_hash: string) => ({ id, steps: [{ transaction_hash }] });

// Auth, then the simulate POST answers `simulated`; list GETs answer `payments`.
async function serve(simulated: { status: number; data: unknown }, payments: unknown[] = []) {
  fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers.Authorization) return Response.json({ access_token: "t" });
    if (String(url).includes("/simulate-inbound")) {
      return Response.json({ data: simulated.data }, { status: simulated.status });
    }
    listed.push(String(url));
    return Response.json({ data: payments, pagination: { has_next: false } });
  });
  await authenticate();
}

const request = { toAccountId: "w1", mockedRiskStatus: "automatically_approved", network: "POLYGON_AMOY" } as const;

beforeEach(() => {
  listed.length = 0;
  process.env.TESSER_CLIENT_ID ||= "test";
  process.env.TESSER_CLIENT_SECRET ||= "test";
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => {
  logSpy.mockRestore();
  fetchSpy.mockRestore();
});

describe("simulateInbound", () => {
  test("returns the payment once it was detected and screened", async () => {
    await serve({ status: 201, data: inbound("p1", "0xabc") });
    expect(await simulateInbound(request)).toBe("p1");
    expect(listed).toEqual([]);
  });

  test("a pending response with a payment id returns that id", async () => {
    await serve({ status: 202, data: { tx_hash: "0xabc", network: "POLYGON_AMOY", status: "pending", payment_id: "p2" } });
    expect(await simulateInbound(request)).toBe("p2");
    expect(listed).toEqual([]);
  });

  test("a pending response without one finds the inbound payment by its transaction hash", async () => {
    await serve(
      { status: 202, data: { tx_hash: "0xABC", network: "POLYGON_AMOY", status: "pending", payment_id: null } },
      [inbound("other", "0xdef"), inbound("p3", "0xabc")],
    );
    expect(await simulateInbound(request)).toBe("p3");
    expect(listed[0]).toContain("/v1/payments?direction=inbound&start_date=");
  });
});

describe("createPayment", () => {
  test("funds the payment from the originator's account, separate from the source", async () => {
    const created: unknown[] = [];
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers.Authorization) return Response.json({ access_token: "t" });
      created.push(JSON.parse(String(init?.body)));
      return Response.json({ data: { id: "p1" } }, { status: 201 });
    });
    await authenticate();

    const paymentId = await createPayment({
      fundingAccountId: "originator-bank",
      fromAccountId: "source-wallet",
      toAccountId: "beneficiary-wallet",
      amount: "0.1",
      currency: "USDC",
      network: "POLYGON_AMOY",
      reference: "ref-1",
    });

    expect(paymentId).toBe("p1");
    expect(created).toEqual([
      {
        organization_reference_id: "ref-1",
        funding_account_id: "originator-bank",
        desired: {
          from: { account_id: "source-wallet", amount: "0.1", currency: "USDC", network: "POLYGON_AMOY" },
          to: { account_id: "beneficiary-wallet", currency: "USDC", network: "POLYGON_AMOY" },
        },
      },
    ]);
  });
});
