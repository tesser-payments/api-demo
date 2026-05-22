// Sequential tutorial runner. Each tutorial under `tutorials/` is a
// concrete walkthrough (no parameters, hardcoded values). They build on
// each other in the numeric prefix order: tutorial 01's output feeds
// tutorial 02 via env var, mimicking how a customer would chain them.
//
// This file is the single source of truth for which tutorials exist and
// in what order. The test driver runs them sequentially, asserts on the
// API resources each one creates, and propagates outputs forward.

import { beforeAll, describe, expect, test } from "vitest";
import { authenticate, get } from "../src/client.ts";
import { tutorial as tutorial01 } from "../tutorials/01-create-a-counterparty.ts";
import { tutorial as tutorial02 } from "../tutorials/02-create-a-ledger.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("tutorials (run in numeric order)", () => {
  beforeAll(async () => {
    await authenticate();
  });

  test(
    "01 → 02 chain produces a counterparty-scoped Circle Mint ledger",
    async () => {
      // ---- Tutorial 01: create counterparty ----------------------------
      const t01 = await tutorial01();
      expect(t01.counterpartyId).toMatch(UUID_RE);

      const cp = await get<{
        data: {
          id: string;
          classification: string;
          business_legal_name: string;
          business_dba: string;
          business_address_country: string;
        };
      }>(`/v1/entities/counterparties/${t01.counterpartyId}`);
      expect(cp.data.id).toBe(t01.counterpartyId);
      expect(cp.data.classification).toBe("business");
      expect(cp.data.business_legal_name).toBe(t01.name);
      expect(cp.data.business_dba).toBe(t01.name);
      expect(cp.data.business_address_country).toBe("US");

      // ---- Tutorial 02: create ledger ----------------------------------
      // Pass tutorial 01's output forward via env var, mimicking the
      // customer workflow. Save and restore so we don't leak to other tests.
      const previousEnv = process.env.COUNTERPARTY_ID;
      process.env.COUNTERPARTY_ID = t01.counterpartyId;
      let t02: Awaited<ReturnType<typeof tutorial02>>;
      try {
        t02 = await tutorial02();
      } finally {
        if (previousEnv === undefined) delete process.env.COUNTERPARTY_ID;
        else process.env.COUNTERPARTY_ID = previousEnv;
      }
      expect(t02.ledgerAccountId).toMatch(UUID_RE);

      const ledger = await get<{
        data: {
          id: string;
          type: string;
          provider: string;
          counterparty_id?: string | null;
          tenant_id?: string | null;
          metadata?: {
            circle_mint?: { circle_compliance_state?: string };
          };
        };
      }>(`/v1/accounts/${t02.ledgerAccountId}`);
      expect(ledger.data.id).toBe(t02.ledgerAccountId);
      expect(ledger.data.type).toBe("ledger");
      expect(ledger.data.provider).toBe("CIRCLE_MINT");
      expect(ledger.data.counterparty_id).toBe(t01.counterpartyId);
      // Per platform rules, the ledger payload carried only counterparty_id;
      // tenant_id stays null on this counterparty-scoped variant.
      expect(ledger.data.tenant_id ?? null).toBeNull();
      expect(ledger.data.metadata?.circle_mint?.circle_compliance_state).toBe(
        "ACCEPTED",
      );
    },
    // 5 min: tutorial 02's Circle compliance poll has a 2-min deadline;
    // give it plus the rest of the chain enough headroom.
    5 * 60 * 1000,
  );
});
