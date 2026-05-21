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
  createdBy: string;
}

export interface SharedTenant {
  id: string;
  createdBy: string;
}

export interface SharedAction {
  ts: string;
  test: string;
  action: "CREATED" | "REUSED";
  kind: string;
  id: string;
  detail?: string;
  // Structured fields for tree-grouped output
  provider?: string;
  currency?: string;
  network?: string;
  tenantId?: string;
}

// Path of the JSON-lines action log. Both the in-worker singleton and the
// main-process teardown reach for the same file. Truncated at globalSetup
// start so each vitest run gets a fresh log.
export const SHARED_STATE_LOG_PATH = join(
  process.env.TMPDIR || "/tmp",
  "api-demo-shared-state.log",
);

class SharedState {
  ledgers: SharedLedger[] = [];
  tenants: SharedTenant[] = [];

  findFundedLedger(filter: { provider: LedgerProvider; currency: string; tenantId?: string }): SharedLedger | undefined {
    return this.ledgers.find(
      (l) =>
        l.hasBalance &&
        l.provider === filter.provider &&
        l.currency === filter.currency &&
        l.tenantId === filter.tenantId,
    );
  }

  registerLedger(ledger: SharedLedger, detail?: string): SharedLedger {
    this.ledgers.push(ledger);
    this.recordAction(ledger.createdBy, "CREATED", "ledger", ledger.id, detail, {
      provider: ledger.provider,
      currency: ledger.currency,
      tenantId: ledger.tenantId,
    });
    return ledger;
  }

  markReused(test: string, kind: string, id: string, detail?: string, extras?: Partial<SharedAction>): void {
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
