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
  test: string;
  action: "CREATED" | "REUSED";
  kind: string;
  id: string;
  detail?: string;
}

class SharedState {
  ledgers: SharedLedger[] = [];
  tenants: SharedTenant[] = [];
  actions: SharedAction[] = [];

  findFundedLedger(filter: { provider: LedgerProvider; currency: string; tenantId?: string }): SharedLedger | undefined {
    return this.ledgers.find(
      (l) =>
        l.hasBalance &&
        l.provider === filter.provider &&
        l.currency === filter.currency &&
        // exact match on tenantId (undefined matches undefined)
        l.tenantId === filter.tenantId,
    );
  }

  registerLedger(ledger: SharedLedger, detail?: string): SharedLedger {
    this.ledgers.push(ledger);
    this.recordAction(ledger.createdBy, "CREATED", "ledger", ledger.id, detail);
    return ledger;
  }

  markReused(test: string, kind: string, id: string, detail?: string): void {
    this.recordAction(test, "REUSED", kind, id, detail);
  }

  recordAction(test: string, action: "CREATED" | "REUSED", kind: string, id: string, detail?: string): void {
    this.actions.push({ test, action, kind, id, detail });
    const color = action === "CREATED" ? pc.green : pc.yellow;
    const tag = color(action.padEnd(7));
    const det = detail ? pc.dim(` (${detail})`) : "";
    console.log(`  ${tag} ${kind} ${pc.cyan(id)}${det}  ${pc.dim("[" + test + "]")}`);
  }

  summary(): string {
    if (this.actions.length === 0) return "(no shared-state actions recorded)";
    const lines = ["Shared-state action log:"];
    for (const a of this.actions) {
      const det = a.detail ? ` (${a.detail})` : "";
      lines.push(`  ${a.action.padEnd(7)} ${a.kind.padEnd(8)} ${a.id}${det}  [${a.test}]`);
    }
    return lines.join("\n");
  }
}

export const sharedState = new SharedState();
