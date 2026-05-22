// Tutorial 01: Create a business counterparty.
//
// This is a concrete, copy-pasteable walkthrough. No optional inputs, no
// branching — just one POST against `/v1/entities/counterparties` with
// the fields the platform requires for a US-based business.
//
// Standalone run:
//   bun run tutorials/01-create-a-counterparty.ts
//
// After it prints the counterparty ID, copy it into the next tutorial:
//   export COUNTERPARTY_ID=<that-id>
//   bun run tutorials/02-create-a-ledger.ts
//
// Derived from the counterparty-creation block in
// `examples/deposit-funds-via-a-liquidity-provider.ts`. If the platform
// changes the required fields, update both — the tutorial test will
// fail on missing fields, surfacing the drift.

import pc from "picocolors";
import { authenticate, post } from "../src/client.ts";

export interface CounterpartyResult {
  counterpartyId: string;
  name: string;
}

export async function tutorial(): Promise<CounterpartyResult> {
  const name = "Acme Holdings LLC";
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
      business_legal_entity_identifier: "ACMEHOLDINGSLLC12345",
    },
  );
  return { counterpartyId: response.data.id, name };
}

if (import.meta.main) {
  await authenticate();
  const result = await tutorial();
  console.log(
    `Created counterparty "${result.name}":  ${pc.cyan(result.counterpartyId)}`,
  );
  console.log("");
  console.log(pc.dim("Next step:"));
  console.log(`  export COUNTERPARTY_ID=${result.counterpartyId}`);
  console.log(`  bun run tutorials/02-create-a-ledger.ts`);
}
