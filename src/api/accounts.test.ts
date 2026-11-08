import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { authenticate } from "../client.ts";
import { assertBalanceHolds, findCounterpartyAccount, waitForBalance } from "./accounts.ts";

let fetchSpy: ReturnType<typeof spyOn>;

const wallet = (id: string, name: string, owner: { tenant_id?: string; counterparty_id?: string } = {}) => ({
  id,
  name,
  tenant_id: null,
  counterparty_id: null,
  ...owner,
});

const listed: string[] = [];

async function serve(accounts: unknown[]) {
  fetchSpy.mockImplementation(async (url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers.Authorization) return Response.json({ access_token: "t" });
    listed.push(String(url));
    return Response.json({ data: accounts, pagination: { has_next: false } });
  });
  await authenticate();
}

beforeEach(() => {
  listed.length = 0;
  process.env.TESSER_CLIENT_ID ||= "test";
  process.env.TESSER_CLIENT_SECRET ||= "test";
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => fetchSpy.mockRestore());

describe("findCounterpartyAccount", () => {
  const query = { type: "fiat_bank", name: "E2E outbound originator" } as const;

  test("matches a counterparty's account of that type by exact name", async () => {
    await serve([
      wallet("a", "E2E outbound originator"),
      wallet("b", "E2E outbound originator (old)", { counterparty_id: "c1" }),
      wallet("c", "E2E outbound originator", { counterparty_id: "c2" }),
    ]);
    expect((await findCounterpartyAccount(query))?.id).toBe("c");
    expect(listed[0]).toContain("/v1/accounts?type=fiat_bank&search=E2E%20outbound%20originator");
  });

  test("returns undefined when none matches", async () => {
    await serve([wallet("a", "E2E outbound originator", { tenant_id: "t1" })]);
    expect(await findCounterpartyAccount(query)).toBeUndefined();
  });

  test("throws when several share the name", async () => {
    await serve([
      wallet("a", "E2E outbound originator", { counterparty_id: "c1" }),
      wallet("b", "E2E outbound originator", { counterparty_id: "c2" }),
    ]);
    await expect(findCounterpartyAccount(query)).rejects.toThrow("2 counterparty accounts");
  });
});

describe("balance checks", () => {
  async function serveBalance(available_balance: string) {
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (!headers.Authorization) return Response.json({ access_token: "t" });
      return Response.json({ data: { id: "w1", assets: [{ currency: "USDC", network: "POLYGON_AMOY", available_balance }] } });
    });
    await authenticate();
  }
  const query = { accountId: "w1", currency: "USDC", network: "POLYGON_AMOY" };

  test("waitForBalance fails on a sub-cent difference above the expected amount", async () => {
    await serveBalance("1.004000");
    await expect(waitForBalance({ ...query, amount: "1.000000" })).rejects.toThrow("more than the expected 1.000000");
  });

  test("assertBalanceHolds fails on a sub-cent drift", async () => {
    await serveBalance("0.899990");
    await expect(assertBalanceHolds({ ...query, amount: "0.900000", holdMs: 0 })).rejects.toThrow("expected it to stay at 0.900000");
  });
});
