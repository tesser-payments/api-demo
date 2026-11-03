import { ApiError, getAll, post } from "../client.ts";
import type { Account } from "../types.ts";

const CIRCLE_SANDBOX_URL = "https://api-sandbox.circle.com";

export interface CircleWireBank {
  id: string;
  status: string;
  description?: string;
}

/**
 * Store the Circle Mint API key in the organization vault. Returns the masked
 * key, or `undefined` if a key is already configured.
 */
export async function storeCircleKey(apiKey: string): Promise<string | undefined> {
  try {
    const result = await post<{ success: boolean; masked_value: string }>(
      "/v1/organizations/secrets",
      {
        provider: "CIRCLE_MINT",
        key: "CIRCLE_MINT_API_KEY",
        value: apiKey,
      },
    );
    return result.masked_value;
  } catch (err) {
    if (
      err instanceof ApiError &&
      (err.hasCode("organizations-0009") || err.message.includes("already configured"))
    ) {
      return undefined;
    }
    // The request body carries the key; keep it out of the error output.
    if (err instanceof Error) err.message = err.message.replaceAll(apiKey, "<redacted>");
    throw err;
  }
}

/**
 * The workspace's Circle master ledger. Throws if Circle isn't connected.
 */
export async function findCircleMasterLedger(): Promise<Account> {
  const ledgers = await getAll<Account>("/v1/accounts?type=ledger");
  const master = ledgers.find((a) => a.provider === "CIRCLE_MINT" && a.created_by === "SYSTEM");
  if (!master) {
    throw new Error(
      "Circle isn't connected to this workspace (no Circle master ledger). Set CIRCLE_API_KEY so the key can be stored.",
    );
  }
  return master;
}

/**
 * The wire bank linked to the Circle account. It is set up outside the Tesser
 * API; without a `complete` one, deposits are never planned and the API gives no reason.
 */
export async function findCircleWireBank(apiKey: string): Promise<CircleWireBank> {
  const url = `${CIRCLE_SANDBOX_URL}/v1/businessAccount/banks/wires`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) {
    throw new Error(`GET ${url} failed (${res.status})\n  Response: ${await res.text()}`);
  }
  const { data: banks = [] } = (await res.json()) as { data?: CircleWireBank[] };

  // The platform uses the first wire bank Circle lists.
  const bank = banks[0];
  if (!bank) {
    throw new Error(
      "The Circle account behind CIRCLE_API_KEY has no linked wire bank, so deposits can't be planned. " +
        "Link one in Circle (sandbox: POST /v1/businessAccount/banks/wires).",
    );
  }
  if (bank.status !== "complete") {
    throw new Error(`The Circle wire bank ${bank.id} is "${bank.status}", not "complete", so deposits can't be planned yet.`);
  }
  return bank;
}
