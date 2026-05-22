// Tutorial 02: Create a Circle Mint ledger account tied to a counterparty.
//
// Reads the counterparty ID that tutorial 01 wrote to
// `tutorials/.state.json`. Registers the Circle Mint API key in the
// vault (idempotent), then POSTs the ledger.
//
// Standalone run (after tutorial 01):
//   bun run tutorials/02-create-a-ledger.ts
//
// Derived from the ledger-creation block in
// `examples/deposit-funds-via-a-liquidity-provider.ts`. The Circle Mint
// platform requires the ledger to carry exactly one of tenant_id or
// counterparty_id; this tutorial uses counterparty_id.

import pc from "picocolors";
import { authenticate, get, post } from "../src/client.ts";
import { loadState, saveState } from "./state.ts";

export interface LedgerResult {
  ledgerAccountId: string;
}

export async function tutorial(): Promise<LedgerResult> {
  const state = loadState();
  if (!state.counterpartyId) {
    throw new Error(
      "tutorials/.state.json is missing `counterpartyId`. " +
        "Run `bun run tutorials/01-create-a-counterparty.ts` first.",
    );
  }
  const circleApiKey = process.env.CIRCLE_API_KEY;
  if (!circleApiKey) {
    throw new Error("CIRCLE_API_KEY is required for Circle Mint ledger creation.");
  }

  // 1. Register the Circle Mint API key in the org vault. The platform
  //    rejects subsequent registrations with `secrets-0002`; swallow it
  //    so the tutorial stays idempotent.
  try {
    await post("/v1/organizations/secrets", {
      provider: "CIRCLE_MINT",
      key: "CIRCLE_MINT_API_KEY",
      value: circleApiKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("secrets-0002")) throw err;
  }

  // 2. Create the ledger account tied to the counterparty.
  const response = await post<{ data: { id: string } }>(
    "/v1/accounts/ledgers",
    {
      name: "Acme Holdings LLC Operating Ledger",
      provider: "CIRCLE_MINT",
      counterparty_id: state.counterpartyId,
    },
  );
  const ledgerAccountId = response.data.id;

  // 3. Wait for Circle to finish provisioning the ledger. Until the
  //    `circle_compliance_state` flips to ACCEPTED, the ledger can't
  //    receive deposits.
  await waitForCircleCompliance(ledgerAccountId);

  saveState({ ledgerAccountId });
  return { ledgerAccountId };
}

async function waitForCircleCompliance(ledgerAccountId: string): Promise<void> {
  const intervalMs = 5_000;
  const deadline = Date.now() + 2 * 60 * 1000;
  while (true) {
    const res = await get<{
      data: {
        metadata?: { circle_mint?: { circle_compliance_state?: string } };
      };
    }>(`/v1/accounts/${ledgerAccountId}`);
    const state = res.data.metadata?.circle_mint?.circle_compliance_state;
    if (state === "ACCEPTED") return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Ledger ${ledgerAccountId} not ACCEPTED within 2 min ` +
          `(circle_compliance_state=${state ?? "unset"})`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

if (import.meta.main) {
  await authenticate();
  const result = await tutorial();
  console.log(`Created ledger:  ${pc.cyan(result.ledgerAccountId)}`);
  console.log("");
  console.log(pc.dim("Saved to tutorials/.state.json."));
}
