// Tutorial 01: Create a business counterparty.
//
// This is a concrete, copy-pasteable walkthrough. No optional inputs, no
// branching — just one POST against `/v1/entities/counterparties` with
// the fields the platform requires for a US-based business.
//
// Running this tutorial clears the local `tutorials/.state.json` and
// writes the new counterparty's ID into it. Tutorial 02 reads from the
// same file, so you can chain them by hand without setting env vars.
//
// Standalone run:
//   bun run tutorials/01-create-a-counterparty.ts
//   bun run tutorials/02-create-a-ledger.ts
//
// Derived from the counterparty-creation block in
// `examples/deposit-funds-via-a-liquidity-provider.ts`. If the platform
// changes the required fields, update both — the tutorial test asserts
// on the resource shape and will surface drift.

import pc from "picocolors";
import { authenticate, post } from "../src/client.ts";
import { clearState, saveState } from "./state.ts";

export interface CounterpartyResult {
  counterpartyId: string;
  name: string;
}

export async function tutorial(): Promise<CounterpartyResult> {
  // Tutorial 01 is the chain's entry point — wiping the state file here
  // means re-running it always starts a fresh chain.
  clearState();

  // Circle Mint deduplicates external entities by (name, legal entity
  // identifier). Re-running the tutorial therefore needs unique values
  // each time. A timestamp suffix keeps the rest of the body concrete
  // and copy-pasteable. In production, you'd swap the suffix for your
  // real registered company name and LEI.
  const runId = Date.now().toString();
  const name = `Acme Holdings LLC #${runId}`;
  const legalEntityIdentifier = `ACME${runId}`;

  const response = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "business",
      business_legal_name: name,
      business_dba: name,
      business_address_country: "US",
      business_street_address1: "123 Main Street",
      business_city: "Springfield",
      business_state: "IL",
      business_postal_code: "62701",
      business_legal_entity_identifier: legalEntityIdentifier,
    },
  );
  const counterpartyId = response.data.id;

  saveState({ counterpartyId });
  return { counterpartyId, name };
}

if (import.meta.main) {
  await authenticate();
  const result = await tutorial();
  console.log(
    `Created counterparty "${result.name}":  ${pc.cyan(result.counterpartyId)}`,
  );
  console.log("");
  console.log(pc.dim("Saved to tutorials/.state.json. Next step:"));
  console.log(`  bun run tutorials/02-create-a-ledger.ts`);
}
