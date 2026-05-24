import { appendFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";

export type LedgerProvider = "CIRCLE_MINT" | "OPENFX" | "KRAKEN";

export interface SharedLedger {
  id: string;
  provider: LedgerProvider;
  currency: string;
  hasBalance: boolean;
  tenantId?: string;
  counterpartyId?: string;
  scope?: string;
  createdBy: string;
}

export interface SharedTenant {
  id: string;
  createdBy: string;
}

export interface SharedAction {
  ts: string;
  test: string;            // free-form test label
  action: "CREATED" | "REUSED";
  kind: string;            // "ledger"
  id: string;
  detail?: string;
  // Resource metadata (set by registerLedger; matches the SharedLedger fields)
  provider?: string;
  currency?: string;
  network?: string;
  tenantId?: string;
  counterpartyId?: string; // NEW
  scope?: string;          // NEW: "workspace" | "counterparty" | "tenant" | "tenant+counterparty"
  // What operation the test performed via this resource (NEW):
  operationKind?: "deposit" | "payment";
  operationId?: string;
  operationSummary?: string; // e.g., "100 USD → USDC" or "0.01 USDC out"
}

// Path of the JSON-lines action log. Both the in-worker singleton and the
// main-process teardown reach for the same file. Truncated at globalSetup
// start so each vitest run gets a fresh log.
export const SHARED_STATE_LOG_PATH = join(
  process.env.TMPDIR || "/tmp",
  "api-demo-shared-state.log",
);

function deriveScope(l: { tenantId?: string; counterpartyId?: string }): string {
  if (l.tenantId && l.counterpartyId) return "tenant+counterparty";
  if (l.tenantId) return "tenant";
  if (l.counterpartyId) return "counterparty";
  return "workspace";
}

class SharedState {
  ledgers: SharedLedger[] = [];
  tenants: SharedTenant[] = [];

  findFundedLedger(filter: { provider: LedgerProvider; currency: string; tenantId?: string; counterpartyId?: string; scope?: string }): SharedLedger | undefined {
    return this.ledgers.find(
      (l) =>
        l.hasBalance &&
        l.provider === filter.provider &&
        l.currency === filter.currency &&
        l.tenantId === filter.tenantId &&
        (filter.counterpartyId === undefined || l.counterpartyId === filter.counterpartyId) &&
        (filter.scope === undefined || l.scope === filter.scope),
    );
  }

  registerLedger(ledger: SharedLedger, detail?: string, extras?: Pick<SharedAction, "operationKind" | "operationId" | "operationSummary">): SharedLedger {
    const scope = ledger.scope ?? deriveScope(ledger);
    const enriched = { ...ledger, scope };
    this.ledgers.push(enriched);
    this.recordAction(enriched.createdBy, "CREATED", "ledger", enriched.id, detail, {
      provider: enriched.provider,
      currency: enriched.currency,
      tenantId: enriched.tenantId,
      counterpartyId: enriched.counterpartyId,
      scope,
      ...extras,
    });
    return enriched;
  }

  markReused(test: string, kind: string, id: string, detail?: string, extras?: Partial<SharedAction>): void {
    // Strip 'originally from ...' detail — CREATED entry already states origin.
    this.recordAction(test, "REUSED", kind, id, detail, extras);
  }

  recordAction(test: string, action: "CREATED" | "REUSED", kind: string, id: string, detail?: string, extras?: Partial<SharedAction>): void {
    const entry: SharedAction = {
      ts: new Date().toISOString(),
      test,
      action,
      kind,
      id,
      detail,
      ...extras,
    };

    // Persist to a shared file so the main-process teardown can summarize.
    try {
      appendFileSync(SHARED_STATE_LOG_PATH, JSON.stringify(entry) + "\n");
    } catch {
      // Filesystem failure is non-fatal; log line below still surfaces.
    }

    // Real-time stderr log so the action is visible during test execution
    // even when vitest intercepts stdout from passing tests.
    const color = action === "CREATED" ? pc.green : pc.yellow;
    const tag = color(action.padEnd(7));
    const det = detail ? pc.dim(` (${detail})`) : "";
    process.stderr.write(
      `  ${tag} ${kind} ${pc.cyan(id)}${det}  ${pc.dim("[" + test + "]")}\n`,
    );
  }
}

export const sharedState = new SharedState();
