import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { authenticate } from "../client.ts";
import { findManagedEvmWallet } from "./accounts.ts";

let fetchSpy: ReturnType<typeof spyOn>;

const wallet = (id: string, name: string, owner: { tenant_id?: string; counterparty_id?: string } = {}) => ({
  id,
  name,
  tenant_id: null,
  counterparty_id: null,
  ...owner,
});

async function serve(accounts: unknown[]) {
  fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (!headers.Authorization) return Response.json({ access_token: "t" });
    return Response.json({ data: accounts, pagination: { has_next: false } });
  });
  await authenticate();
}

beforeEach(() => {
  process.env.TESSER_CLIENT_ID ||= "test";
  process.env.TESSER_CLIENT_SECRET ||= "test";
  fetchSpy = spyOn(globalThis, "fetch");
});
afterEach(() => fetchSpy.mockRestore());

describe("findManagedEvmWallet", () => {
  test("matches the workspace's wallet by exact name", async () => {
    await serve([
      wallet("a", "E2E inbound, auto-approved (old)"),
      wallet("b", "E2E inbound, auto-approved", { tenant_id: "t1" }),
      wallet("c", "E2E inbound, auto-approved"),
    ]);
    expect((await findManagedEvmWallet("E2E inbound, auto-approved"))?.id).toBe("c");
  });

  test("returns undefined when none matches", async () => {
    await serve([wallet("a", "Treasury")]);
    expect(await findManagedEvmWallet("E2E inbound, auto-approved")).toBeUndefined();
  });

  test("throws when several share the name", async () => {
    await serve([wallet("a", "E2E inbound, auto-approved"), wallet("b", "E2E inbound, auto-approved")]);
    await expect(findManagedEvmWallet("E2E inbound, auto-approved")).rejects.toThrow("2 managed wallets");
  });
});
