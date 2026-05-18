# Stage 2 — Deposit-via-LP First Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the first per-flow example + test wrapper in the new architecture (`examples/` + `tests/flows/` + `tests/helpers/expected-events.ts`), validating the spec's design end-to-end against the real sandbox.

**Architecture:** A clean "deposit funds via a liquidity provider" reference implementation (no test imports) under `examples/`, plus a thin assertion-heavy test wrapper under `tests/flows/` that shares the `src/webhooks.ts` primitive from stage 1. Expected webhook event sequence is transcribed from docs.tesser.xyz, not inferred from observed behavior.

**Tech Stack:** Bun (runtime/packaging), Vitest (test runner), `@tesser-payments/types` (typed responses + WEBHOOK_PUBLIC_KEY), webhook.site REST poll (already wired in stage 1).

**Prerequisites (must be in `.env` before running end-to-end):**
- `TESSER_CLIENT_ID`, `TESSER_CLIENT_SECRET` — sandbox OAuth credentials
- `WEBHOOK_SITE_TOKEN` — the webhook.site token corresponding to the URL already configured as sandbox's webhook destination
- `CIRCLE_API_KEY` — Circle Mint sandbox key (stored in Tesser vault on first run; idempotent)

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `examples/deposit-funds-via-a-liquidity-provider.ts` | Clean, demo-quality reference: creates counterparty + ledger + bank, posts deposit, simulates, polls. Exports `meta`, `Input`/`Result` types, `run(input)`, `import.meta.main` block. Zero test imports. |
| `tests/helpers/expected-events.ts` | Single source of truth for expected webhook event sequences. Each constant has a `// Source:` URL and a `// Last verified:` date. |
| `tests/flows/deposit-funds-via-a-liquidity-provider.test.ts` | Vitest wrapper. `beforeEach` authenticates + starts subscription; `afterEach` stops. Calls `run`, collects events scoped to `depositId`, asserts on sequence + signature validity + DEA overlay. |
| `vitest.config.ts` | Add `test.fileParallelism: false` (replaces the spec's `bunfig.toml` plan for serial execution). |

---

## Task 1: Configure Vitest for serial flow execution

**Files:**
- Modify: `vitest.config.ts`

- [ ] **Step 1: Update vitest config**

Replace the file with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Flow tests share one webhook.site token and the sandbox is sequential
    // by design. Parallel file execution would interleave webhook arrivals.
    fileParallelism: false,
    // Generous default test timeout for sandbox round-trips with retries.
    testTimeout: 300_000,
    server: {
      deps: {
        // @tesser-payments/types uses directory-style ESM imports that
        // Node's native resolver rejects. Force Vite to handle it.
        inline: [/@tesser-payments\/types/],
      },
    },
  },
});
```

- [ ] **Step 2: Verify unit tests still pass**

Run: `bun run test`
Expected: 17 tests pass across the two existing unit-test files.

- [ ] **Step 3: Commit**

```bash
git add vitest.config.ts
git commit -m "test: serialize vitest flow execution and raise test timeout"
```

---

## Task 2: Encode the doc-sourced expected event sequence

**Files:**
- Create: `tests/helpers/expected-events.ts`

- [ ] **Step 1: Write the expected-events module**

```ts
/**
 * Hand-transcribed expected webhook event sequences, sourced from
 * docs.tesser.xyz. Drift between docs and platform surfaces as a test
 * failure — when that happens, re-read the doc, decide whether the doc
 * or the platform is wrong, and update accordingly. Never update these
 * constants to match observed behavior without consulting the doc.
 */

/**
 * Source: https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider
 * Scenario: Ledger deposit at Circle Mint (this example's flow).
 * Last verified: 2026-05-18
 */
export const EXPECTED_DEPOSIT_LP = {
  types: [
    "deposit.quote_created",
    "step.completed",
    "step.completed",
    "deposit.updated",
  ] as const,
  terminal: {
    desired: {
      from: { currency: "USD" },
      to: { currency: "USDC" },
    },
    // estimated populated after quote; actual populated once steps complete.
  },
} as const;
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: only the pre-existing `scripts/tesser-payment-test.ts` error remains; no new errors.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/expected-events.ts
git commit -m "test: encode doc-sourced expected webhook sequence for deposit-via-LP"
```

---

## Task 3: Scaffold the example file (types + meta + signature)

**Files:**
- Create: `examples/deposit-funds-via-a-liquidity-provider.ts`

This task lands the contract first. The next task fills in the body.

- [ ] **Step 1: Write the scaffold**

```ts
import pc from "picocolors";
import { faker } from "@faker-js/faker";
import { authenticate, get, getAll, post } from "../src/client.ts";

export const meta = {
  name: "Deposit funds via a liquidity provider (Circle Mint)",
  description:
    "USD → USDC into a managed Circle Mint ledger. Creates a fresh counterparty + ledger each run, finds-or-creates an org-level unmanaged bank, posts a deposit, simulates it, and polls until the DEA overlay's `actual` populates.",
  docUrl:
    "https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider",
} as const;

export interface DepositLpInput {
  /** Amount in fromCurrency, as a decimal string (e.g. "100.00"). */
  depositAmount: string;
  /** Defaults to "USD". */
  fromCurrency?: string;
  /** Defaults to "USDC". */
  toCurrency?: string;
}

export interface DepositLpResult {
  depositId: string;
  ledgerAccountId: string;
  deposit: DepositResponse;
}

interface DepositResponse {
  id: string;
  desired?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  estimated?: unknown;
  actual?: {
    from?: { currency?: string; amount?: string };
    to?: { currency?: string; amount?: string };
  };
  steps?: {
    step_sequence: number;
    status: string;
    status_reasons?: string | null;
    finalized_at?: string | null;
    completed_at?: string | null;
  }[];
}

export async function run(input: DepositLpInput): Promise<DepositLpResult> {
  throw new Error("not implemented");
}

if (import.meta.main) {
  await authenticate();
  const result = await run({
    depositAmount: process.env.TESSER_TEST_DEPOSIT_AMOUNT ?? "100.00",
  });
  console.log(pc.green(`\nDeposit ${result.depositId} complete.`));
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: only the pre-existing `scripts/tesser-payment-test.ts` error.

- [ ] **Step 3: Commit**

```bash
git add examples/deposit-funds-via-a-liquidity-provider.ts
git commit -m "feat(examples): scaffold deposit-via-LP flow contract"
```

---

## Task 4: Implement the deposit flow body

**Files:**
- Modify: `examples/deposit-funds-via-a-liquidity-provider.ts`

- [ ] **Step 1: Replace the `run` stub with the full flow**

Replace the body of `run(input)` with the following. (Imports were already added in Task 3 — only the body changes.)

```ts
export async function run(input: DepositLpInput): Promise<DepositLpResult> {
  const fromCurrency = input.fromCurrency ?? "USD";
  const toCurrency = input.toCurrency ?? "USDC";

  // 1. Store Circle Mint API key in vault (idempotent).
  await ensureCircleMintKey();

  // 2. Find-or-create an org-level unmanaged bank account as funding source.
  const fundingBankId = await findOrCreateFundingBank();
  console.log(`  Funding bank: ${pc.cyan(fundingBankId)}`);

  // 3. Create a fresh business counterparty for this run.
  const customerName = faker.company.name();
  const customer = await post<{ data: { id: string } }>(
    "/v1/entities/counterparties",
    {
      classification: "business",
      business_legal_name: customerName,
      business_dba: customerName,
      business_address_country: "US",
      business_street_address1: faker.location.streetAddress(),
      business_city: faker.location.city(),
      business_state: faker.location.state({ abbreviated: true }),
      business_postal_code: faker.location.zipCode(),
      business_legal_entity_identifier: faker.string.alphanumeric({
        length: 20,
        casing: "upper",
      }),
    },
  );
  console.log(
    `  Counterparty: ${customerName} ${pc.dim(`(${customer.data.id})`)}`,
  );

  // 4. Create a Circle Mint ledger account tied to that counterparty.
  const ledger = await post<{ data: { id: string } }>(
    "/v1/accounts/ledgers",
    {
      name: `${customerName}'s Ledger`,
      provider: "CIRCLE_MINT",
      counterparty_id: customer.data.id,
    },
  );
  const ledgerAccountId = ledger.data.id;
  console.log(`  Ledger account: ${pc.cyan(ledgerAccountId)}`);

  // 5. Create the deposit.
  const created = await post<{ data: DepositResponse }>(
    "/v1/treasury/deposits",
    {
      tenant_id: null,
      desired: {
        from: {
          account_id: fundingBankId,
          amount: input.depositAmount,
          currency: fromCurrency,
        },
        to: {
          account_id: ledgerAccountId,
          currency: toCurrency,
        },
      },
    },
  );
  const depositId = created.data.id;
  console.log(`  Deposit ID: ${pc.cyan(depositId)}`);

  // 6. Sandbox-only: simulate the deposit so funds arrive.
  await post(`/v1/treasury/deposits/${depositId}/simulate`, {});
  console.log(pc.dim("  Simulated"));

  // 7. Poll the deposit resource until DEA `actual.to.amount` populates.
  const terminal = await pollDepositTerminal(depositId);

  return { depositId, ledgerAccountId, deposit: terminal };
}

async function ensureCircleMintKey(): Promise<void> {
  const apiKey = process.env.CIRCLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "CIRCLE_API_KEY is required for the deposit-via-LP example. " +
        "Set it in .env and re-run.",
    );
  }
  try {
    await post("/v1/organizations/secrets", {
      provider: "CIRCLE_MINT",
      key: "CIRCLE_MINT_API_KEY",
      value: apiKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // secrets-0002 means "already configured" — idempotent.
    if (!msg.includes("secrets-0002")) throw err;
  }
}

async function findOrCreateFundingBank(): Promise<string> {
  const accounts = await getAll<{
    id: string;
    type: string;
    is_managed?: boolean | null;
    tenant_id?: string | null;
    counterparty_id?: string | null;
  }>("/v1/accounts");

  const existing = accounts.find(
    (a) =>
      a.type === "fiat_bank" &&
      !a.is_managed &&
      !a.tenant_id &&
      !a.counterparty_id,
  );
  if (existing) return existing.id;

  const created = await post<{ data: { id: string } }>("/v1/accounts/banks", {
    name: "Depositing Bank",
    bank_name: "Hancock Whitney Bank",
    bank_code_type: "ROUTING",
    bank_identifier_code: "065400153",
    bank_account_number: "000999999991",
    tenant_id: null,
    counterparty_id: null,
    bank_swift_code: "BARCGB22",
  });
  return created.data.id;
}

async function pollDepositTerminal(depositId: string): Promise<DepositResponse> {
  const intervalMs = 5_000;
  const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes
  let lastLog = "";
  while (true) {
    const res = await get<{ data: DepositResponse }>(
      `/v1/treasury/deposits/${depositId}`,
    );
    const d = res.data;
    const failed = d.steps?.find((s) => s.status === "failed");
    if (failed) {
      throw new Error(
        `Deposit step ${failed.step_sequence} failed: ${failed.status_reasons}`,
      );
    }
    const log = (d.steps ?? [])
      .map((s) => `step${s.step_sequence}=${s.status}`)
      .join(", ");
    if (log !== lastLog) {
      console.log(pc.yellow(`  Poll: ${log}`));
      lastLog = log;
    }
    if (d.actual?.to?.amount) {
      console.log(
        pc.green(`  Deposit terminal: actual.to=${d.actual.to.amount}`),
      );
      return d;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Deposit ${depositId} did not terminate within 5 min`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: only the pre-existing `scripts/tesser-payment-test.ts` error.

- [ ] **Step 3: Run the example standalone against sandbox**

Prereqs: `.env` has TESSER_CLIENT_ID, TESSER_CLIENT_SECRET, CIRCLE_API_KEY.

Run: `bun run examples/deposit-funds-via-a-liquidity-provider.ts`

Expected: example prints counterparty, ledger, deposit IDs; polls; ends with `Deposit <id> complete.` Exit 0. Sandbox now has a new counterparty + ledger.

If the run fails, do not change the example to match observed errors blindly — diagnose. Common causes:
- `secrets-0002` not handled → already in `ensureCircleMintKey`, swallow.
- Bank account creation 4xx → inspect response body in error message.
- Polling timeout → confirm `simulate` returned 2xx; check the sandbox's Circle Mint connection status.

- [ ] **Step 4: Commit**

```bash
git add examples/deposit-funds-via-a-liquidity-provider.ts
git commit -m "feat(examples): implement deposit-via-LP flow body"
```

---

## Task 5: Write the test wrapper

**Files:**
- Create: `tests/flows/deposit-funds-via-a-liquidity-provider.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { authenticate } from "../../src/client.ts";
import {
  subscribeToWebhooks,
  type WebhookSubscription,
} from "../../src/webhooks.ts";
import { run } from "../../examples/deposit-funds-via-a-liquidity-provider.ts";
import { EXPECTED_DEPOSIT_LP } from "../helpers/expected-events.ts";

describe("deposit funds via a liquidity provider (Circle Mint)", () => {
  let sub: WebhookSubscription;

  beforeEach(async () => {
    if (!process.env.WEBHOOK_SITE_TOKEN) {
      throw new Error(
        "WEBHOOK_SITE_TOKEN is required to run flow tests. Set it in .env.",
      );
    }
    await authenticate();
    sub = subscribeToWebhooks({ token: process.env.WEBHOOK_SITE_TOKEN });
    sub.startWindow();
  });

  afterEach(() => {
    sub?.stop();
  });

  test(
    "emits expected event sequence and progresses DEA overlays",
    async () => {
      const result = await run({ depositAmount: "100.00" });

      const events = await sub.scopedTo(result.depositId).collectAll({
        expectedTypes: EXPECTED_DEPOSIT_LP.types,
        timeoutMs: 180_000,
      });

      expect(events.map((e) => e.type)).toEqual([
        ...EXPECTED_DEPOSIT_LP.types,
      ]);
      expect(events.every((e) => e.signatureValid)).toBe(true);
      expect(result.deposit.desired).toMatchObject(
        EXPECTED_DEPOSIT_LP.terminal.desired,
      );
      expect(result.deposit.estimated).toBeDefined();
      expect(result.deposit.actual?.to?.amount).toBeDefined();
    },
    300_000,
  );
});
```

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc --noEmit`
Expected: only the pre-existing `scripts/tesser-payment-test.ts` error.

- [ ] **Step 3: Commit**

```bash
git add tests/flows/deposit-funds-via-a-liquidity-provider.test.ts
git commit -m "test(flows): add deposit-via-LP webhook + overlay assertions"
```

---

## Task 6: Run end-to-end against sandbox

**Files:** (no changes)

- [ ] **Step 1: Run the full test suite**

Prereqs: `.env` has TESSER_CLIENT_ID, TESSER_CLIENT_SECRET, CIRCLE_API_KEY, WEBHOOK_SITE_TOKEN.

Run: `bun run test`

Expected outcomes, in priority order:
1. **Green:** 17 unit tests + 1 flow test pass. Stage 2 is done.
2. **Sequence mismatch:** `events.map(e=>e.type)` differs from `EXPECTED_DEPOSIT_LP.types`.
   - Do **not** edit the constant to match observed output.
   - Re-read https://docs.tesser.xyz/how-tos/deposit-funds-via-a-liquidity-provider.
   - If the doc agrees with the test's expectation, the platform has drifted — escalate. Stop and ask the user.
   - If the doc disagrees with the test's expectation, our transcription was wrong — update the constant + bump `Last verified:`.
3. **Signature invalid:** `events.every(e=>e.signatureValid)` is false.
   - Inspect one event's `signature` and `rawBody`. Verify the header was the `X-Tesser-Signature` (case-insensitive) and the body wasn't re-serialized in transit.
   - Spec Section 10 flagged this as a verification step. If real signatures don't verify, escalate.
4. **`actual.to.amount` undefined:** deposit polling returned a non-terminal resource.
   - Increase the example's polling deadline, or inspect the deposit resource shape in the sandbox.
5. **Webhook timeout:** `WebhookTimeout` with a `missing` field.
   - Confirm sandbox's webhook URL points to the same webhook.site token in `WEBHOOK_SITE_TOKEN`.
   - Confirm `belongsTo` correlation — print `events.map(e => e.type)` from the timeout's diagnostic and check `data.object.id` / `data.object.deposit_id` for each.

- [ ] **Step 2: Commit any final fixes**

If you needed to adjust anything in Tasks 2-5 to make the test green, commit those fixes with descriptive messages. Do **not** amend prior commits — make new ones.

---

## Out of scope for stage 2

- CI workflow (`.github/workflows/e2e.yml`) flip from current → `vitest run tests/flows/`. That's stage 3 of the migration plan.
- The other 8 examples in the spec's Initial `examples/` population table.
- Failure-path tests (rejected risk, insufficient balance, expired payments). Spec lists these as v1 out-of-scope.
- Resource cleanup — sandbox accumulates state per run; teardown utility is a future ticket.
- The existing `index.ts` and `scripts/` continue to work unchanged. They will be migrated/deleted in later stages.
