import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Interaction } from "./interaction.ts";
import { sanitize } from "./output.ts";

export type KrakenDashboardKind = "deposit" | "funding-deposit" | "swap" | "withdrawal";

type DashboardStatus = "running" | "completed" | "failed";
type StageStatus = "pending" | "active" | "completed" | "failed";

type DashboardStage = {
  id: string;
  label: string;
  status: StageStatus;
  detail?: string;
};

type DashboardDefinition = {
  title: string;
  outputPath: string;
  stages: Array<{ id: string; label: string }>;
};

const definitions: Record<KrakenDashboardKind, DashboardDefinition> = {
  deposit: {
    title: "Tesser BRL deposit into Kraken",
    outputPath: "ui/kraken/deposit/index.html",
    stages: [
      { id: "configure", label: "Review deposit values" },
      { id: "authenticate", label: "Authenticate with Tesser" },
      { id: "create", label: "Create or load deposit" },
      { id: "plan", label: "Wait for Tesser planning" },
      { id: "instructions", label: "Verify deposit instructions" },
      { id: "transfer", label: "Submit PIX in Kraken" },
      { id: "reconcile", label: "Wait for reconciliation" },
    ],
  },
  "funding-deposit": {
    title: "Kraken Funding API deposit",
    outputPath: "ui/kraken/funding-deposit/index.html",
    stages: [
      { id: "configure", label: "Review deposit values" },
      { id: "method", label: "Select funding method" },
      { id: "baseline", label: "Record existing deposits" },
      { id: "instructions", label: "Prepare deposit instructions" },
      { id: "detect", label: "Wait for successful deposit" },
    ],
  },
  swap: {
    title: "Kraken USD to USDC swap",
    outputPath: "ui/kraken/swap/index.html",
    stages: [
      { id: "configure", label: "Review swap amount" },
      { id: "balance", label: "Check available USD" },
      { id: "market", label: "Select USDC/USD market" },
      { id: "validate", label: "Validate market order" },
      { id: "create", label: "Place market order" },
      { id: "settle", label: "Wait for order completion" },
    ],
  },
  withdrawal: {
    title: "Kraken onchain withdrawal",
    outputPath: "ui/kraken/withdrawal/index.html",
    stages: [
      { id: "configure", label: "Select network and target" },
      { id: "quote", label: "Calculate withdrawal fee" },
      { id: "balance", label: "Check available balance" },
      { id: "create", label: "Create withdrawal" },
      { id: "settle", label: "Wait for withdrawal completion" },
    ],
  },
};

export class KrakenDashboard {
  readonly outputPath: string;
  private readonly definition: DashboardDefinition;
  private status: DashboardStatus = "running";
  private action: string;
  private error?: string;
  private data: Record<string, unknown> = {};
  private stages: DashboardStage[];

  constructor(
    readonly kind: KrakenDashboardKind,
    outputPath = definitions[kind].outputPath,
  ) {
    this.definition = definitions[kind];
    this.outputPath = resolve(outputPath);
    this.action = this.definition.stages[0]?.label ?? "Preparing Kraken workflow";
    this.stages = this.definition.stages.map((stage) => ({
      ...stage,
      status: "pending",
    }));
  }

  start(): void {
    this.render();
  }

  update(stageId: string, action: string, data?: Record<string, unknown>, detail?: string): void {
    const activeIndex = this.stages.findIndex((stage) => stage.id === stageId);
    if (activeIndex < 0) throw new Error(`Unknown Kraken dashboard stage: ${stageId}`);
    this.action = action;
    if (data) this.data = sanitize(data) as Record<string, unknown>;
    this.stages = this.stages.map((stage, index) => ({
      ...stage,
      status: index < activeIndex ? "completed" : index === activeIndex ? "active" : "pending",
      detail: index === activeIndex && detail ? detail : stage.detail,
    }));
    this.render();
  }

  complete(data?: Record<string, unknown>): void {
    this.status = "completed";
    this.action = "Kraken workflow completed";
    if (data) this.data = sanitize(data) as Record<string, unknown>;
    this.stages = this.stages.map((stage) => ({
      ...stage,
      status: "completed",
    }));
    this.render();
  }

  fail(message: string): void {
    this.status = "failed";
    this.action = "Kraken workflow stopped";
    this.error = message;
    const activeIndex = this.stages.findIndex((stage) => stage.status === "active");
    if (activeIndex >= 0) {
      this.stages[activeIndex] = {
        ...this.stages[activeIndex]!,
        status: "failed",
        detail: message,
      };
    }
    this.render();
  }

  private render(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(
      this.outputPath,
      renderKrakenDashboard(
        this.definition.title,
        this.kind,
        this.status,
        this.action,
        this.stages,
        this.data,
        this.error,
      ),
    );
  }
}

export async function resolveKrakenUi(
  interaction: Interaction,
  withUi: boolean | undefined,
  kind: KrakenDashboardKind,
  validateOnly = false,
): Promise<boolean> {
  if (withUi) return true;
  if (!interaction.interactive || validateOnly) return false;
  return interaction.confirm(`Enable UI? (Creates ${definitions[kind].outputPath} for live progress)`, false);
}

function renderKrakenDashboard(
  title: string,
  kind: KrakenDashboardKind,
  status: DashboardStatus,
  action: string,
  stages: DashboardStage[],
  data: Record<string, unknown>,
  error?: string,
): string {
  const refresh = status === "running" ? '<meta http-equiv="refresh" content="2">' : "";
  const stageCards = stages
    .map(
      (stage, index) => `<li class="stage stage-${stage.status}">
        <span class="stage-number">${index + 1}</span>
        <span class="stage-copy"><strong>${escapeHtml(stage.label)}</strong>${stage.detail ? `<small>${escapeHtml(stage.detail)}</small>` : ""}</span>
        <span class="stage-status">${escapeHtml(stage.status)}</span>
      </li>`,
    )
    .join("");
  const failure = error
    ? `<section class="failure"><strong>Workflow failed</strong><span>${escapeHtml(error)}</span></section>`
    : "";
  const snapshot = escapeHtml(JSON.stringify(data, null, 2));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${refresh}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #080b12; color: #eef1ff; --purple: #8b5cf6; --green: #5ee6a8; --blue: #68c9ff; --red: #ff7585; --muted: #969db2; }
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: radial-gradient(circle at 50% -15%, #26174a 0, #0d1020 38%, #080b12 75%); }
.page { width: min(960px, calc(100% - 32px)); margin: 0 auto; padding: 36px 0 64px; }
.hero, .panel, .failure { border: 1px solid #292e42; border-radius: 18px; background: rgba(16, 20, 34, .92); box-shadow: 0 24px 70px rgba(0, 0, 0, .28); }
.hero { padding: 24px; }
.hero-top { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; }
.eyebrow { color: #b6a1ff; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
h1 { margin: 7px 0 0; font-size: clamp(25px, 5vw, 40px); letter-spacing: -.035em; }
.badge { border: 1px solid currentColor; border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
.badge-running { color: var(--blue); }.badge-completed { color: var(--green); }.badge-failed { color: var(--red); }
.action { margin-top: 20px; padding: 13px 15px; border: 1px solid #3c3472; border-radius: 12px; background: #171632; color: #dcd5ff; }
.grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(280px, .9fr); gap: 18px; margin-top: 18px; }
.panel { padding: 20px; min-width: 0; }
h2 { margin: 0 0 16px; font-size: 17px; }
.stages { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.stage { display: grid; grid-template-columns: 30px minmax(0, 1fr) auto; gap: 11px; align-items: center; padding: 13px; border: 1px solid #292e42; border-radius: 12px; color: var(--muted); }
.stage-number { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: #20253a; font-size: 12px; font-weight: 800; }
.stage-copy { display: grid; gap: 4px; min-width: 0; }.stage-copy strong { color: #d9ddef; }.stage-copy small { overflow-wrap: anywhere; }
.stage-status { font-size: 10px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
.stage-active { border-color: #6253ba; background: #181735; color: var(--blue); }.stage-active .stage-number { background: var(--purple); color: white; }
.stage-completed { color: var(--green); }.stage-completed .stage-number { background: #173f35; }
.stage-failed { border-color: #7f3441; background: #351a23; color: var(--red); }.stage-failed .stage-number { background: #7f3441; color: white; }
.failure { display: grid; gap: 5px; margin-top: 18px; padding: 17px 20px; border-color: #7f3441; color: #ffd6db; }.failure strong { color: var(--red); }
pre { max-height: 640px; margin: 0; overflow: auto; color: #c8cee3; font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { color: var(--muted); }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; }.hero-top { display: grid; }.badge { justify-self: start; } }
</style>
</head>
<body>
<main class="page">
  <section class="hero">
    <div class="hero-top"><div><div class="eyebrow">Kraken · ${escapeHtml(kind)}</div><h1>${escapeHtml(title)}</h1></div><span class="badge badge-${status}">${escapeHtml(status)}</span></div>
    <div class="action">${escapeHtml(action)}</div>
  </section>
  ${failure}
  <div class="grid">
    <section class="panel"><h2>Progress</h2><ol class="stages">${stageCards}</ol></section>
    <section class="panel"><h2>Latest response</h2>${Object.keys(data).length ? `<pre>${snapshot}</pre>` : '<div class="empty">Waiting for workflow data.</div>'}</section>
  </div>
</main>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
