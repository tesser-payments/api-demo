import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sanitize } from "./output.ts";

type DashboardStatus = "running" | "completed" | "failed";
type EventStatus = "complete" | "active" | "waiting" | "failed" | "skipped" | "pending";
type ActorId = "cli" | "tesser" | "signer" | "network" | "openfx" | "bank" | "ledger";
type DashboardResource = "withdrawal" | "rebalance";

type Actor = {
  id: ActorId;
  label: string;
  shortLabel: string;
};

type SequenceEvent = {
  id: string;
  stepId?: string;
  at?: string;
  from: ActorId;
  to: ActorId;
  label: string;
  detail?: string;
  status: EventStatus;
};

type FailureSummary = {
  title: string;
  message: string;
  action: string;
  code?: string;
};

const actors: Actor[] = [
  { id: "cli", label: "Playground CLI", shortLabel: "CLI" },
  { id: "tesser", label: "Tesser API", shortLabel: "Tesser" },
  { id: "signer", label: "Local signer", shortLabel: "Signer" },
  { id: "network", label: "Blockchain", shortLabel: "Network" },
  { id: "openfx", label: "OpenFX", shortLabel: "OpenFX" },
  { id: "bank", label: "Destination bank", shortLabel: "Bank" },
];

const rebalanceActors: Actor[] = [
  { id: "cli", label: "Playground CLI", shortLabel: "CLI" },
  { id: "tesser", label: "Tesser API", shortLabel: "Tesser" },
  { id: "signer", label: "Local signer", shortLabel: "Signer" },
  { id: "network", label: "Blockchain", shortLabel: "Network" },
  { id: "openfx", label: "OpenFX", shortLabel: "OpenFX" },
  { id: "ledger", label: "OpenFX ledger", shortLabel: "Ledger" },
];

export class WithdrawalDashboard {
  readonly outputPath: string;
  private status: DashboardStatus = "running";
  private action = "Preparing withdrawal";
  private withdrawal: Record<string, unknown> = {};
  private error?: string;

  constructor(outputPath = "ui/withdrawal/index.html") {
    this.outputPath = resolve(outputPath);
  }

  start(): void {
    this.render();
  }

  updateAction(action: string): void {
    this.action = action;
    this.render();
  }

  updateWithdrawal(withdrawal: Record<string, unknown>): void {
    this.withdrawal = sanitize(withdrawal) as Record<string, unknown>;
    this.render();
  }

  complete(): void {
    this.status = "completed";
    this.action = "Every withdrawal step completed";
    this.render();
  }

  fail(message: string): void {
    this.status = "failed";
    this.error = message;
    this.action = "Withdrawal stopped";
    this.render();
  }

  private render(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(
      this.outputPath,
      renderDashboard("withdrawal", this.withdrawal, this.status, this.action, this.error),
    );
  }
}

export class RebalanceDashboard {
  readonly outputPath: string;
  private status: DashboardStatus = "running";
  private action = "Preparing rebalance";
  private rebalance: Record<string, unknown> = {};
  private error?: string;

  constructor(outputPath = "ui/rebalance/index.html") {
    this.outputPath = resolve(outputPath);
  }

  start(): void {
    this.render();
  }

  updateAction(action: string): void {
    this.action = action;
    this.render();
  }

  updateRebalance(rebalance: Record<string, unknown>): void {
    this.rebalance = sanitize(rebalance) as Record<string, unknown>;
    this.render();
  }

  complete(): void {
    this.status = "completed";
    this.action = "Every rebalance step completed";
    this.render();
  }

  fail(message: string): void {
    this.status = "failed";
    this.error = message;
    this.action = "Rebalance stopped";
    this.render();
  }

  private render(): void {
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(
      this.outputPath,
      renderDashboard("rebalance", this.rebalance, this.status, this.action, this.error),
    );
  }
}

function renderDashboard(
  resource: DashboardResource,
  withdrawal: Record<string, unknown>,
  status: DashboardStatus,
  action: string,
  error?: string,
): string {
  const resourceLabel = capitalize(resource);
  const dashboardActors = actorsFor(resource);
  const steps = withdrawalSteps(withdrawal);
  const events = sequenceEvents(resource, withdrawal, steps, status, action);
  const failure = failureSummary(resource, steps, error);
  const withdrawalId = text(withdrawal.id);
  const reference = text(withdrawal.organization_reference_id);
  const balanceStatus = text(withdrawal.balance_status);
  const createdAt = text(withdrawal.created_at);
  const updatedAt = text(withdrawal.updated_at);
  const requestedFrom = endpoint(withdrawal, "desired", "from");
  const estimatedTo = endpoint(withdrawal, "estimated", "to");
  const amountSummary = `${displayValue(requestedFrom.amount)} ${displayValue(requestedFrom.currency)} → ${displayValue(estimatedTo.amount)} ${displayValue(estimatedTo.currency)}`;
  const network = displayValue(requestedFrom.network);
  const refresh = status === "running" ? '<meta http-equiv="refresh" content="2">' : "";
  const statusLabel = status === "running" ? "In progress" : capitalize(status);
  const actorHeaders = dashboardActors
    .map((actor) => `<div class="actor actor-${actor.id}"><span>${escapeHtml(actor.label)}</span></div>`)
    .join("");
  const eventRows = events.map((event) => renderSequenceEvent(resource, event)).join("");
  const stepButtons = steps.length
    ? steps.map((step) => renderStepButton(resource, step)).join("")
    : `<div class="empty-state">Waiting for Tesser to plan the ${resource} steps.</div>`;
  const stepTemplates = steps.map((step) => renderStepTemplate(resource, step)).join("");
  const failureHtml = failure ? renderFailure(failure, error) : "";
  const safeWithdrawal = escapeHtml(JSON.stringify(withdrawal, null, 2));
  const storageKey = `tesser-${resource}-dashboard:${withdrawalId || "pending"}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${refresh}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tesser ${resourceLabel} ${escapeHtml(withdrawalId || "")}</title>
<style>
:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #07100e;
  color: #dce9e4;
  --surface: #0b1714;
  --surface-raised: #10201c;
  --border: #263d36;
  --border-soft: #172a25;
  --muted: #8ca49b;
  --green: #68e8b6;
  --blue: #77d7ee;
  --amber: #f4cb72;
  --red: #ff8f97;
}
* { box-sizing: border-box; }
body { margin: 0; min-width: 320px; background: radial-gradient(circle at 50% -20%, #12332a 0, #07100e 42%); }
button, summary { font: inherit; }
button { color: inherit; }
.page { width: calc(100% - 32px); max-width: 1280px; margin: 0 auto; padding: 32px 0 56px; }
.hero, .panel, .failure-panel, .detail-panel { border: 1px solid var(--border); background: color-mix(in srgb, var(--surface) 94%, transparent); box-shadow: 0 24px 70px rgba(0,0,0,.22); }
.hero { border-radius: 20px; padding: 24px; margin-bottom: 18px; }
.hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; }
.eyebrow { color: var(--muted); font-size: 12px; font-weight: 750; letter-spacing: .13em; text-transform: uppercase; }
h1 { margin: 6px 0 0; font-size: clamp(24px, 4vw, 38px); letter-spacing: -.035em; line-height: 1.05; }
.status-badge { border: 1px solid currentColor; border-radius: 999px; padding: 7px 11px; font-size: 12px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; white-space: nowrap; }
.status-running { color: var(--blue); background: rgba(119,215,238,.08); }
.status-completed { color: var(--green); background: rgba(104,232,182,.08); }
.status-failed { color: var(--red); background: rgba(255,143,151,.08); }
.hero-meta { display: flex; flex-wrap: wrap; gap: 8px 18px; margin-top: 16px; color: var(--muted); font-size: 13px; }
.hero-meta strong { color: #cfe0da; font-weight: 650; }
.hero-meta span, .failure-heading > div { min-width: 0; overflow-wrap: anywhere; }
.copy-button { appearance: none; border: 0; padding: 0; background: none; color: var(--blue); cursor: pointer; }
.copy-button:hover { color: #b9effb; }
.current-action { display: flex; align-items: center; gap: 10px; margin-top: 18px; padding: 12px 14px; border: 1px solid #204451; border-radius: 12px; background: #0d2429; color: #afe9f5; }
.pulse { width: 8px; height: 8px; flex: 0 0 auto; border-radius: 50%; background: var(--blue); box-shadow: 0 0 0 0 rgba(119,215,238,.55); animation: pulse 1.8s infinite; }
@keyframes pulse { 70% { box-shadow: 0 0 0 8px rgba(119,215,238,0); } 100% { box-shadow: 0 0 0 0 rgba(119,215,238,0); } }
.failure-panel { border-color: #76383e; border-radius: 18px; padding: 20px; margin-bottom: 18px; background: linear-gradient(135deg, rgba(75,29,34,.82), rgba(29,18,20,.9)); }
.failure-heading { display: flex; gap: 12px; align-items: flex-start; }
.failure-icon { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 auto; border-radius: 50%; background: var(--red); color: #321014; font-weight: 900; }
.failure-panel h2 { margin: 0; font-size: 19px; }
.failure-panel p { margin: 7px 0 0; color: #f0c9cc; line-height: 1.55; }
.failure-action { margin-top: 15px; padding: 12px 14px; border-radius: 10px; background: rgba(255,255,255,.055); }
.failure-action strong { display: block; margin-bottom: 3px; color: #fff; }
.panel { border-radius: 18px; margin-bottom: 18px; overflow: hidden; }
.panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--border-soft); }
.panel-heading h2 { margin: 0; font-size: 17px; }
.live-label { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: 12px; }
.live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); }
.diagram-scroll { overflow: visible; }
.sequence { width: 100%; }
.actor-row, .event-row { display: grid; grid-template-columns: 76px repeat(6, minmax(0, 1fr)); }
.actor-row { position: sticky; top: 0; z-index: 8; background: #0d1a17; border-bottom: 1px solid var(--border); }
.time-head, .actor { min-height: 64px; display: grid; place-items: center; padding: 10px; color: #b8cbc4; font-size: 12px; font-weight: 750; text-align: center; }
.time-head { color: var(--muted); }
.actor { position: relative; }
.actor::after { content: ""; position: absolute; z-index: 2; bottom: -6px; left: 50%; width: 9px; height: 9px; border: 2px solid #3d5e54; border-radius: 50%; background: #0d1a17; transform: translateX(-50%); }
.event-row { position: relative; min-height: 92px; }
.event-time { grid-column: 1; grid-row: 1; display: flex; justify-content: center; padding-top: 35px; color: #718b82; font-size: 11px; font-variant-numeric: tabular-nums; }
.lane-cell { grid-row: 1; position: relative; }
.lane-cell::before { content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px; background: #29433b; }
.event-card { --event-color: #71847d; grid-row: 1; position: relative; z-index: 2; align-self: stretch; min-width: 0; margin: 0; padding: 0; border: 0; background: transparent; text-align: center; cursor: default; }
button.event-card { width: auto; appearance: none; cursor: pointer; }
button.event-card:hover .event-copy, button.event-card.selected .event-copy { background: #142b25; box-shadow: 0 0 0 1px #5e8f80; }
.event-arrow { position: absolute; z-index: 2; top: 68px; left: calc(50% / var(--event-span)); right: calc(50% / var(--event-span)); height: 2px; background: var(--event-color); }
.event-arrow::after { content: ""; position: absolute; top: -4px; right: 0; width: 7px; height: 7px; border-top: 2px solid var(--event-color); border-right: 2px solid var(--event-color); transform: rotate(45deg); transform-origin: center; }
.event-card.reverse .event-arrow::after { left: 0; right: auto; transform: rotate(-135deg); }
.event-card.same-actor .event-arrow { left: 50%; right: auto; width: 10px; height: 10px; border: 2px solid var(--event-color); border-radius: 50%; background: var(--surface); transform: translate(-50%, -4px); }
.event-card.same-actor .event-arrow::after { display: none; }
.event-copy { position: absolute; z-index: 3; top: 12px; left: 50%; width: max-content; max-width: calc(100% - 24px); min-width: 120px; padding: 4px 8px; border-radius: 7px; background: var(--surface); transform: translateX(-50%); }
.event-title { display: flex; align-items: center; justify-content: center; gap: 7px; font-size: 12px; font-weight: 760; line-height: 1.25; }
.event-detail { display: block; overflow: hidden; margin-top: 3px; color: var(--muted); font-size: 10px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
.event-route { display: none; margin-top: 4px; color: var(--muted); font-size: 10px; }
.event-dot { width: 8px; height: 8px; flex: 0 0 auto; border: 2px solid currentColor; border-radius: 50%; }
.event-complete { --event-color: var(--green); color: var(--green); }
.event-active { --event-color: var(--blue); color: var(--blue); }
.event-active .event-dot { background: currentColor; animation: pulse 1.8s infinite; }
.event-waiting { --event-color: var(--amber); color: var(--amber); }
.event-failed { --event-color: var(--red); color: var(--red); }
.event-skipped { --event-color: #53655f; color: #71847d; }
.event-skipped .event-arrow { background: repeating-linear-gradient(90deg,var(--event-color) 0 5px,transparent 5px 9px); }
.event-pending { --event-color: #53655f; color: #71847d; }
.stages { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; padding: 16px; }
.stage { appearance: none; border: 1px solid var(--border); border-radius: 12px; padding: 13px; background: var(--surface-raised); text-align: left; cursor: pointer; }
.stage:hover, .stage.selected { border-color: #5e8f80; background: #142b25; }
.stage-top { display: flex; justify-content: space-between; gap: 10px; }
.stage-number { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
.stage-status { font-size: 11px; font-weight: 800; text-transform: uppercase; }
.stage-title { display: block; margin-top: 8px; font-weight: 720; }
.stage-detail { display: block; overflow: hidden; margin-top: 4px; color: var(--muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.detail-panel { position: fixed; z-index: 20; top: 16px; right: 16px; bottom: 16px; width: min(440px, calc(100% - 32px)); border-radius: 18px; overflow: auto; padding: 20px; background: #0b1714; }
.detail-panel[hidden] { display: none; }
.detail-header { display: flex; justify-content: space-between; gap: 15px; align-items: flex-start; }
.detail-header h2 { margin: 4px 0 0; font-size: 20px; }
.close-button { appearance: none; width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface-raised); cursor: pointer; }
.detail-grid { display: grid; grid-template-columns: minmax(110px, .65fr) 1fr; gap: 9px 14px; margin: 20px 0; font-size: 13px; }
.detail-grid dt { color: var(--muted); }
.detail-grid dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
.reason { margin: 10px 0; padding: 12px; border-left: 3px solid var(--red); border-radius: 8px; background: #251719; color: #efc5c8; font-size: 12px; line-height: 1.5; }
.hash-note { margin: 12px 0; padding: 11px; border-radius: 9px; background: #12231f; color: var(--muted); font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
.hash-note strong { color: #dce9e4; }
.hash-note a { color: var(--blue); }
.raw { border-top: 1px solid var(--border-soft); }
.raw summary { padding: 15px 0; color: var(--muted); cursor: pointer; }
.raw pre { max-height: 420px; overflow: auto; margin: 0; padding: 14px; border-radius: 10px; background: #06100d; color: #b9cec6; font: 11px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.raw-actions { display: flex; justify-content: flex-end; margin: -4px 0 8px; }
.small-button { appearance: none; border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; background: var(--surface-raised); color: var(--blue); font-size: 11px; cursor: pointer; }
.empty-state { grid-column: 1 / -1; padding: 22px; color: var(--muted); text-align: center; }
.technical-panel { padding: 0 18px 18px; }
@media (max-width: 760px) {
  .page { width: calc(100% - 20px); max-width: 640px; padding-top: 14px; }
  .hero { padding: 18px; }
  .hero-top { flex-direction: column; gap: 12px; }
  .sequence { width: 100%; }
  .actor-row { display: none; }
  .event-row { display: grid; grid-template-columns: 62px 1fr; min-height: 92px; }
  .event-time { grid-column: 1; grid-row: 1; padding-top: 31px; }
  .lane-cell { display: none; }
  .event-card, button.event-card { grid-column: 2 !important; grid-row: 1; width: auto; }
  .event-arrow, .event-card.same-actor .event-arrow { left: 5px; right: auto; top: 0; bottom: 0; width: 2px; height: auto; border: 0; border-radius: 0; background: var(--event-color); transform: none; }
  .event-skipped .event-arrow { background: repeating-linear-gradient(180deg,var(--event-color) 0 5px,transparent 5px 9px); }
  .event-arrow::after, .event-card.same-actor .event-arrow::after { display: none; }
  .event-copy { position: static; width: auto; max-width: none; min-width: 0; margin: 11px 10px 11px 20px; padding: 8px; background: transparent; transform: none; text-align: left; }
  .event-title { justify-content: flex-start; }
  .event-detail { white-space: normal; }
  .event-route { display: block; }
  .panel-heading { padding: 15px; }
  .stages { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}
</style>
</head>
<body>
<main class="page">
  <section class="hero">
    <div class="hero-top">
      <div><div class="eyebrow">${resourceLabel}</div><h1>${escapeHtml(amountSummary)}</h1></div>
      <div class="status-badge status-${status}">${escapeHtml(statusLabel)}</div>
    </div>
    <div class="hero-meta">
      <span>Network <strong>${escapeHtml(network)}</strong></span>
      <span>Balance <strong>${escapeHtml(balanceStatus)}</strong></span>
      <span>ID <button class="copy-button" data-copy="${escapeHtml(withdrawalId)}">${escapeHtml(shortId(withdrawalId))}</button></span>
      <span>Reference <strong>${escapeHtml(reference)}</strong></span>
      <span>Started <strong data-relative-time="${escapeHtml(createdAt)}">${escapeHtml(formatTimestamp(createdAt))}</strong></span>
      <span>Updated <strong data-relative-time="${escapeHtml(updatedAt)}">${escapeHtml(formatTimestamp(updatedAt))}</strong></span>
    </div>
    <div class="current-action"><span class="pulse"></span><span>${escapeHtml(action)}</span></div>
  </section>
  ${failureHtml}
  <section class="panel">
    <div class="panel-heading">
      <h2>${resourceLabel} sequence</h2>
      ${status === "running" ? '<span class="live-label"><span class="live-dot"></span>Refreshing every 2 seconds</span>' : `<span class="live-label">${escapeHtml(statusLabel)}</span>`}
    </div>
    <div class="diagram-scroll">
      <div class="sequence">
        <div class="actor-row"><div class="time-head">Time</div>${actorHeaders}</div>
        ${eventRows}
      </div>
    </div>
  </section>
  <section class="panel">
    <div class="panel-heading"><h2>Transfer steps</h2><span class="live-label">Select a step for details</span></div>
    <div class="stages">${stepButtons}</div>
  </section>
  <section class="panel technical-panel">
    <details class="raw">
      <summary>Raw ${resource} JSON</summary>
      <div class="raw-actions"><button class="small-button" data-copy-previous>Copy JSON</button></div>
      <pre>${safeWithdrawal}</pre>
    </details>
  </section>
</main>
<aside class="detail-panel" id="detail-panel" hidden>
  <div class="detail-header">
    <div><div class="eyebrow">Transfer step</div><h2 id="detail-title">Step details</h2></div>
    <button class="close-button" id="detail-close" aria-label="Close details">×</button>
  </div>
  <div id="detail-content"></div>
</aside>
${stepTemplates}
<script>
const storageKey = ${serializeForScript(storageKey)};
const detailPanel = document.getElementById("detail-panel");
const detailTitle = document.getElementById("detail-title");
const detailContent = document.getElementById("detail-content");
const stepControls = Array.from(document.querySelectorAll("[data-step-id]"));

function copyText(value, button) {
  const complete = () => {
    const previous = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = previous; }, 1200);
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(value).then(complete);
    return;
  }
  const input = document.createElement("textarea");
  input.value = value;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
  complete();
}

function openStep(stepId) {
  const template = Array.from(document.querySelectorAll("template[data-step-template]"))
    .find((candidate) => candidate.dataset.stepTemplate === stepId);
  if (!template) return;
  detailContent.replaceChildren(template.content.cloneNode(true));
  detailTitle.textContent = template.dataset.stepTitle || "Step details";
  detailPanel.hidden = false;
  stepControls.forEach((control) => control.classList.toggle("selected", control.dataset.stepId === stepId));
  sessionStorage.setItem(storageKey, stepId);
  bindCopyButtons(detailPanel);
}

function closeStep() {
  detailPanel.hidden = true;
  stepControls.forEach((control) => control.classList.remove("selected"));
  sessionStorage.removeItem(storageKey);
}

function bindCopyButtons(root = document) {
  root.querySelectorAll("[data-copy]").forEach((button) => {
    if (button.dataset.copyBound) return;
    button.dataset.copyBound = "true";
    button.addEventListener("click", () => copyText(button.dataset.copy || "", button));
  });
  root.querySelectorAll("[data-copy-previous]").forEach((button) => {
    if (button.dataset.copyBound) return;
    button.dataset.copyBound = "true";
    button.addEventListener("click", () => {
      const pre = button.parentElement?.nextElementSibling;
      copyText(pre?.textContent || "", button);
    });
  });
}

function relativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value || "—";
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function refreshRelativeTimes() {
  document.querySelectorAll("[data-relative-time]").forEach((element) => {
    element.textContent = relativeTime(element.dataset.relativeTime || "");
  });
}

stepControls.forEach((control) => control.addEventListener("click", () => openStep(control.dataset.stepId)));
document.getElementById("detail-close").addEventListener("click", closeStep);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeStep(); });
bindCopyButtons();
refreshRelativeTimes();
setInterval(refreshRelativeTimes, 1000);
const selectedStep = sessionStorage.getItem(storageKey);
if (selectedStep) openStep(selectedStep);
</script>
</body>
</html>`;
}

function sequenceEvents(
  resource: DashboardResource,
  withdrawal: Record<string, unknown>,
  steps: Record<string, unknown>[],
  dashboardStatus: DashboardStatus,
  action: string,
): SequenceEvent[] {
  const events: SequenceEvent[] = [];
  const withdrawalId = text(withdrawal.id);
  events.push({
    id: `create-${resource}`,
    at: text(withdrawal.created_at),
    from: "cli",
    to: "tesser",
    label: `Create ${resource}`,
    detail: withdrawalId ? `${capitalize(resource)} ${shortId(withdrawalId)}` : action,
    status: withdrawalId ? "complete" : dashboardEventStatus(dashboardStatus),
  });
  if (!steps.length) {
    events.push({
      id: `plan-${resource}`,
      from: "tesser",
      to: "tesser",
      label: "Plan transfer steps",
      detail: action,
      status: dashboardEventStatus(dashboardStatus),
    });
    return events;
  }
  for (const step of steps) events.push(...eventsForStep(resource, step));
  return events;
}

function eventsForStep(
  resource: DashboardResource,
  step: Record<string, unknown>,
): SequenceEvent[] {
  const stepId = text(step.id);
  const sequence = Number(step.step_sequence ?? 0);
  const provider = text(step.provider_key).toLowerCase();
  const stepType = text(step.step_type).toLowerCase();
  const status = stepEventStatus(step);
  const estimatedFrom = endpoint(step, "estimated", "from");
  const estimatedTo = endpoint(step, "estimated", "to");
  const transferDetail = `${displayValue(estimatedFrom.amount)} ${displayValue(estimatedFrom.currency)} → ${displayValue(estimatedTo.amount)} ${displayValue(estimatedTo.currency)}`;
  if (sequence === 1 && provider === "turnkey") {
    const events: SequenceEvent[] = [];
    const signatureRequestedAt = text(step.signature_requested_at);
    const signedAt = text(step.signed_at);
    const submittedAt = text(step.submitted_at);
    const confirmedAt = text(step.confirmed_at);
    if (signatureRequestedAt) {
      events.push({
        id: `${stepId}-signature-requested`,
        stepId,
        at: signatureRequestedAt,
        from: "tesser",
        to: "cli",
        label: "Request wallet signature",
        detail: transferDetail,
        status: "complete",
      });
    }
    if (signedAt) {
      events.push({
        id: `${stepId}-signed-locally`,
        stepId,
        at: signedAt,
        from: "cli",
        to: "signer",
        label: "Sign wallet transaction",
        detail: `Nonce ${reasonParameter(step, "nonce") ?? "allocated"}`,
        status: "complete",
      });
      events.push({
        id: `${stepId}-signature-submitted`,
        stepId,
        at: signedAt,
        from: "signer",
        to: "tesser",
        label: "Submit signature",
        detail: text(step.transaction_hash) ? "Transaction hash computed locally" : undefined,
        status: "complete",
      });
    }
    if (submittedAt) {
      events.push({
        id: `${stepId}-broadcast`,
        stepId,
        at: submittedAt,
        from: "tesser",
        to: "network",
        label: "Broadcast wallet transfer",
        detail: transferDetail,
        status: "complete",
      });
    } else if (signedAt) {
      events.push({
        id: `${stepId}-broadcast`,
        stepId,
        at: text(step.failed_at),
        from: "tesser",
        to: "network",
        label: status === "failed" ? "Broadcast blocked by nonce queue" : "Wait for broadcast turn",
        detail: statusReasonMessage(step) || transferDetail,
        status: status === "failed" ? "failed" : "waiting",
      });
    } else if (status === "failed" || status === "skipped") {
      events.push({
        id: `${stepId}-wallet-step`,
        stepId,
        at: text(step.failed_at),
        from: "tesser",
        to: "cli",
        label: "Wallet transfer stopped",
        detail: statusReasonMessage(step),
        status,
      });
    }
    if (confirmedAt) {
      events.push({
        id: `${stepId}-confirmed`,
        stepId,
        at: confirmedAt,
        from: "network",
        to: resource === "rebalance" ? "ledger" : "tesser",
        label: "Confirm wallet transfer",
        detail: shortHash(text(step.transaction_hash)),
        status: "complete",
      });
    }
    if (resource === "rebalance" && text(step.completed_at)) {
      events.push({
        id: `${stepId}-openfx-deposit`,
        stepId,
        at: text(step.completed_at),
        from: "ledger",
        to: "tesser",
        label: "Credit OpenFX ledger",
        detail: "Mock deposit matched by the OpenFX webhook",
        status: "complete",
      });
    } else if (resource === "rebalance" && (confirmedAt || submittedAt)) {
      events.push({
        id: `${stepId}-openfx-deposit`,
        stepId,
        from: "ledger",
        to: "tesser",
        label: "Wait for OpenFX mock deposit",
        detail: transferDetail,
        status: "waiting",
      });
    }
    if (!events.length) {
      events.push({
        id: `${stepId}-prepare-signature`,
        stepId,
        at: text(step.created_at),
        from: "tesser",
        to: "cli",
        label: "Prepare wallet signature",
        detail: transferDetail,
        status,
      });
    }
    return events;
  }
  if (stepType === "swap") {
    return [
      { id: `${stepId}-swap`, stepId, at: stepTimestamp(step), from: "tesser", to: "openfx", label: "Convert funds through OpenFX", detail: transferDetail, status },
      openFxStatusWebhookEvent(step, stepId, status),
    ];
  }
  if (provider === "openfx" || sequence >= 3) {
    const events: SequenceEvent[] = [
      { id: `${stepId}-payout`, stepId, at: stepTimestamp(step), from: "openfx", to: "bank", label: "Send funds to destination bank", detail: transferDetail, status },
    ];
    if (provider === "openfx") events.push(openFxStatusWebhookEvent(step, stepId, status));
    return events;
  }
  return [{ id: `${stepId}-provider-step`, stepId, at: stepTimestamp(step), from: "tesser", to: "openfx", label: `${capitalize(stepType || "provider")} step`, detail: transferDetail, status }];
}

function openFxStatusWebhookEvent(
  step: Record<string, unknown>,
  stepId: string,
  status: EventStatus,
): SequenceEvent {
  return {
    id: `${stepId}-status-webhook`,
    stepId,
    at: stepTimestamp(step),
    from: "openfx",
    to: "tesser",
    label: "Report transfer step status",
    detail: `Transfer step status: ${displayValue(step.status)}`,
    status,
  };
}

function renderSequenceEvent(resource: DashboardResource, event: SequenceEvent): string {
  const dashboardActors = actorsFor(resource);
  const fromIndex = dashboardActors.findIndex((actor) => actor.id === event.from);
  const toIndex = dashboardActors.findIndex((actor) => actor.id === event.to);
  const firstActor = Math.min(fromIndex, toIndex) + 2;
  const lastActor = Math.max(fromIndex, toIndex) + 3;
  const actorSpan = Math.abs(fromIndex - toIndex) + 1;
  const directionClass = fromIndex > toIndex ? " reverse" : fromIndex === toIndex ? " same-actor" : "";
  const stepAttribute = event.stepId ? ` data-step-id="${escapeHtml(event.stepId)}"` : "";
  const tag = event.stepId ? "button" : "div";
  const detail = event.detail ? `<span class="event-detail">${escapeHtml(event.detail)}</span>` : "";
  const from = actorLabel(resource, event.from);
  const to = actorLabel(resource, event.to);
  const route = from === to ? from : `${from} → ${to}`;
  const lanes = dashboardActors.map(() => '<span class="lane-cell"></span>').join("");
  return `<div class="event-row" data-event-id="${escapeHtml(event.id)}">
    <time class="event-time" datetime="${escapeHtml(event.at ?? "")}">${escapeHtml(formatTime(event.at))}</time>
    ${lanes}
    <${tag} class="event-card event-${event.status}${directionClass}" style="--event-span:${actorSpan};grid-column:${firstActor}/${lastActor}"${stepAttribute}>
      <span class="event-arrow"></span>
      <span class="event-copy">
        <span class="event-title"><span class="event-dot"></span>${escapeHtml(event.label)}</span>
        ${detail}
        <span class="event-route">${escapeHtml(route)}</span>
      </span>
    </${tag}>
  </div>`;
}

function renderStepButton(resource: DashboardResource, step: Record<string, unknown>): string {
  const sequence = displayValue(step.step_sequence);
  const visualStatus = stepEventStatus(step);
  const status = displayValue(step.status);
  const stepId = text(step.id);
  const estimatedFrom = endpoint(step, "estimated", "from");
  const estimatedTo = endpoint(step, "estimated", "to");
  const detail = `${displayValue(estimatedFrom.amount)} ${displayValue(estimatedFrom.currency)} → ${displayValue(estimatedTo.amount)} ${displayValue(estimatedTo.currency)}`;
  return `<button class="stage" data-step-id="${escapeHtml(stepId)}">
    <span class="stage-top"><span class="stage-number">Step ${escapeHtml(sequence)}</span><span class="stage-status event-${visualStatus}">${escapeHtml(status)}</span></span>
    <span class="stage-title">${escapeHtml(businessStepTitle(resource, step))}</span>
    <span class="stage-detail">${escapeHtml(detail)}</span>
  </button>`;
}

function renderStepTemplate(resource: DashboardResource, step: Record<string, unknown>): string {
  const stepId = text(step.id);
  const sequence = displayValue(step.step_sequence);
  const provider = displayValue(step.provider_key);
  const status = displayValue(step.status);
  const transactionHash = text(step.transaction_hash);
  const submittedAt = text(step.submitted_at);
  const network = text(endpoint(step, "estimated", "from").network);
  const explorerUrl = submittedAt ? transactionExplorerUrl(network, transactionHash) : undefined;
  const hashHtml = transactionHash
    ? explorerUrl
      ? `<div class="hash-note"><strong>Broadcast transaction</strong><br><a href="${escapeHtml(explorerUrl)}" target="_blank" rel="noreferrer">${escapeHtml(transactionHash)}</a></div>`
      : `<div class="hash-note"><strong>Locally computed transaction hash</strong><br>${escapeHtml(transactionHash)}<br>This identifies the signed payload but does not prove it reached the network.</div>`
    : "";
  const reasons = statusReasons(step)
    .map((reason) => `<div class="reason"><strong>${escapeHtml(text(reason.error_code) || "Failure")}</strong><br>${escapeHtml(text(reason.error_message) || "No reason supplied")}</div>`)
    .join("");
  const rows: Array<[string, unknown]> = [
    ["Step ID", step.id],
    ["Provider", provider],
    ["Type", step.step_type],
    ["Status", status],
    ["Created", step.created_at],
    ["Signature requested", step.signature_requested_at],
    ["Signed", step.signed_at],
    ["Submitted", step.submitted_at],
    ["Confirmed", step.confirmed_at],
    ["Completed", step.completed_at],
    ["Failed", step.failed_at],
  ];
  const details = rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(displayValue(value))}</dd>`)
    .join("");
  const rawStep = escapeHtml(JSON.stringify(step, null, 2));
  return `<template data-step-template="${escapeHtml(stepId)}" data-step-title="Step ${escapeHtml(sequence)} · ${escapeHtml(businessStepTitle(resource, step))}">
    <dl class="detail-grid">${details}</dl>
    ${hashHtml}
    ${reasons}
    <details class="raw">
      <summary>Raw step JSON</summary>
      <div class="raw-actions"><button class="small-button" data-copy-previous>Copy JSON</button></div>
      <pre>${rawStep}</pre>
    </details>
  </template>`;
}

function renderFailure(failure: FailureSummary, error?: string): string {
  const code = failure.code ? `<span class="eyebrow">${escapeHtml(failure.code)}</span>` : "";
  const technical = error
    ? `<details class="raw"><summary>Technical error</summary><pre>${escapeHtml(error)}</pre></details>`
    : "";
  return `<section class="failure-panel">
    <div class="failure-heading">
      <span class="failure-icon">!</span>
      <div>${code}<h2>${escapeHtml(failure.title)}</h2><p>${escapeHtml(failure.message)}</p></div>
    </div>
    <div class="failure-action"><strong>Recommended action</strong>${escapeHtml(failure.action)}</div>
    ${technical}
  </section>`;
}

function failureSummary(
  resource: DashboardResource,
  steps: Record<string, unknown>[],
  error?: string,
): FailureSummary | undefined {
  const reasons = steps.flatMap((step) => statusReasons(step));
  const rootReason = reasons.find((reason) => text(reason.error_code) !== "transfers-9201") ?? reasons[0];
  const code = text(rootReason?.error_code);
  const message = text(rootReason?.error_message);
  if (code === "transfers-9311") {
    const nonce = reasonParameterFromMessage(message, "nonce");
    const previousNonce = nonce !== undefined && Number(nonce) > 0 ? String(Number(nonce) - 1) : "a lower nonce";
    return {
      code,
      title: "Nonce queue timed out",
      message: `This transaction used nonce ${nonce ?? "ahead of the queue"}, but nonce ${previousNonce} from an earlier transfer was never submitted. Nothing from this ${resource} was broadcast to the blockchain.`,
      action: `Create a new ${resource}. This failed ${resource} cannot be resumed.`,
    };
  }
  if (code === "transfers-9312") {
    return {
      code,
      title: "An earlier wallet transfer failed",
      message: "This transaction's place in the wallet nonce queue became invalid before it could be broadcast.",
      action: `Create a new ${resource} after the failed wallet queue has cleared.`,
    };
  }
  if (rootReason) {
    return {
      code: code || undefined,
      title: `${capitalize(resource)} step failed`,
      message: message || `A transfer step failed before the ${resource} completed.`,
      action: `Review the failed step details before creating another ${resource}.`,
    };
  }
  if (error) {
    return {
      title: `${capitalize(resource)} stopped`,
      message: firstSentence(error),
      action: "Review the technical error and the last completed event before retrying.",
    };
  }
  return undefined;
}

function withdrawalSteps(withdrawal: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(withdrawal.steps)) return [];
  return withdrawal.steps
    .filter((step): step is Record<string, unknown> => Boolean(step && typeof step === "object"))
    .sort((left, right) => Number(left.step_sequence ?? 0) - Number(right.step_sequence ?? 0));
}

function stepEventStatus(step: Record<string, unknown>): EventStatus {
  const status = text(step.status).toLowerCase();
  const codes = statusReasons(step).map((reason) => text(reason.error_code));
  if (status === "failed" && codes.length > 0 && codes.every((code) => code === "transfers-9201")) return "skipped";
  if (status === "failed") return "failed";
  if (status === "completed" || status === "confirmed") return "complete";
  if (status === "signed") return "waiting";
  if (["submitted", "processing", "pending"].includes(status)) return "active";
  return "pending";
}

function dashboardEventStatus(status: DashboardStatus): EventStatus {
  if (status === "completed") return "complete";
  return status === "running" ? "active" : "failed";
}

function statusReasons(step: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(step.status_reasons)) return [];
  return step.status_reasons.filter(
    (reason): reason is Record<string, unknown> => Boolean(reason && typeof reason === "object"),
  );
}

function statusReasonMessage(step: Record<string, unknown>): string | undefined {
  return text(statusReasons(step)[0]?.error_message) || undefined;
}

function reasonParameter(step: Record<string, unknown>, name: string): string | undefined {
  return reasonParameterFromMessage(statusReasonMessage(step) ?? "", name);
}

function reasonParameterFromMessage(message: string, name: string): string | undefined {
  return new RegExp(`${name}:\\s*([^,\\)]+)`).exec(message)?.[1]?.trim();
}

function businessStepTitle(
  resource: DashboardResource,
  step: Record<string, unknown>,
): string {
  const sequence = Number(step.step_sequence ?? 0);
  const type = text(step.step_type).toLowerCase();
  if (sequence === 1) {
    return resource === "rebalance"
      ? "Move funds from wallet to OpenFX ledger"
      : "Move funds from source wallet";
  }
  if (type === "swap") return "Convert funds through OpenFX";
  if (sequence >= 3) return "Send funds to destination bank";
  return `${capitalize(type || "Transfer")} funds`;
}

function stepTimestamp(step: Record<string, unknown>): string | undefined {
  return text(
    step.failed_at ?? step.completed_at ?? step.confirmed_at ?? step.submitted_at ?? step.signed_at ?? step.created_at,
  ) || undefined;
}

function endpoint(value: Record<string, unknown>, overlayName: string, direction: string): Record<string, unknown> {
  return record(record(value[overlayName])[direction]);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function actorsFor(resource: DashboardResource): Actor[] {
  return resource === "rebalance" ? rebalanceActors : actors;
}

function actorLabel(resource: DashboardResource, id: ActorId): string {
  return actorsFor(resource).find((actor) => actor.id === id)?.shortLabel ?? id;
}

function transactionExplorerUrl(network: string, transactionHash: string): string | undefined {
  if (!transactionHash) return undefined;
  const explorerByNetwork: Record<string, string> = {
    BASE: "https://basescan.org/tx/",
    BASE_SEPOLIA: "https://sepolia.basescan.org/tx/",
    ETHEREUM: "https://etherscan.io/tx/",
    ETHEREUM_SEPOLIA: "https://sepolia.etherscan.io/tx/",
    POLYGON: "https://polygonscan.com/tx/",
    POLYGON_AMOY: "https://amoy.polygonscan.com/tx/",
  };
  const baseUrl = explorerByNetwork[network.toUpperCase()];
  return baseUrl ? `${baseUrl}${encodeURIComponent(transactionHash)}` : undefined;
}

function formatTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(date);
}

function formatTimestamp(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function shortId(value: string): string {
  if (!value) return "—";
  return value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function shortHash(value: string): string | undefined {
  if (!value) return undefined;
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
}

function displayValue(value: unknown): string {
  return text(value) || "—";
}

function text(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function firstSentence(value: string): string {
  const sentence = value.split(/(?<=[.!?])\s/, 1)[0] ?? value;
  return sentence.length > 240 ? `${sentence.slice(0, 237)}…` : sentence;
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
