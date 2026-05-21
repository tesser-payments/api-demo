// Wraps `vitest run` with a pre-pass that prints the planned flow-test
// combos (one row per how-to × provider × currency × network) at the top
// of the log. Vitest 4 collects+runs interleaved, so a reporter alone
// can't print the plan before any test starts.
//
// We use `vitest list` to enumerate, filter to flow tests (which carry
// the structured metadata in their name), and render as a matrix.
// Unit-test count is shown as a single line.

import { spawn, spawnSync } from "node:child_process";
import pc from "picocolors";

const SEED = process.env.VITEST_SEED ?? String(Date.now());
process.env.VITEST_SEED = SEED;

const COL = {
  doc: 38,
  provider: 12,
  currency: 9,
  network: 14,
  description: 32,
};

interface ParsedVariant {
  docSlug: string;
  provider?: string;
  currency?: string;
  network?: string;
  description: string;
}

function parseVariantFromName(name: string): ParsedVariant | undefined {
  const parts = name.split(" | ");
  if (parts.length < 2) return undefined;
  const slug = parts[0]!;
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) return undefined;
  const v: ParsedVariant = {
    docSlug: slug,
    description: parts[parts.length - 1]!,
  };
  for (const part of parts.slice(1, -1)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.startsWith("provider=")) v.provider = part.slice(eq + 1);
    else if (part.startsWith("currency=")) v.currency = part.slice(eq + 1);
    else if (part.startsWith("network=")) v.network = part.slice(eq + 1);
  }
  return v;
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function renderFlowRow(v: ParsedVariant, prefix = "  ·  "): string {
  return [
    prefix,
    pad(trunc(v.docSlug, COL.doc), COL.doc),
    pad(trunc(v.provider ?? "-", COL.provider), COL.provider),
    pad(trunc(v.currency ?? "-", COL.currency), COL.currency),
    pad(trunc(v.network ?? "-", COL.network), COL.network),
    v.description,
  ].join("  ");
}

function renderFlowHeader(): string {
  return [
    "     ", // align with " ·  " prefix
    pad("Doc", COL.doc),
    pad("Provider", COL.provider),
    pad("Currency", COL.currency),
    pad("Network", COL.network),
    "Description",
  ].join("  ");
}

function renderDivider(): string {
  return [
    "-----",
    "-".repeat(COL.doc),
    "-".repeat(COL.provider),
    "-".repeat(COL.currency),
    "-".repeat(COL.network),
    "-".repeat(COL.description),
  ].join("  ");
}

// Run `vitest list` (same seed, same shuffle config) to enumerate tests.
const list = spawnSync("bunx", ["vitest", "list"], { encoding: "utf8" });
if (list.status !== 0) {
  console.error("vitest list failed");
  if (list.stderr) console.error(list.stderr);
  process.exit(list.status ?? 1);
}

const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
const lines = (list.stdout + (list.stderr ?? ""))
  .split("\n")
  .map(stripAnsi)
  .filter((line) => line.includes(".test.ts >"));

interface ListedTest {
  modulePath: string;
  fullName: string;
  variant?: ParsedVariant;
}

const listed: ListedTest[] = lines.map((line) => {
  const sep = line.indexOf(" > ");
  const modulePath = sep > 0 ? line.slice(0, sep) : line;
  const rest = sep > 0 ? line.slice(sep + 3) : line;
  const trailing = rest.split(" > ").pop() ?? rest;
  return { modulePath, fullName: rest, variant: parseVariantFromName(trailing) };
});

const flow = listed.filter((t) => t.variant);
const unitCount = listed.length - flow.length;

console.log("");
console.log(pc.bold(pc.cyan(`== Tests planned  (VITEST_SEED=${SEED}) ==`)));
console.log("");
if (flow.length > 0) {
  console.log(pc.bold(`Flow tests (${flow.length}, run in random order):`));
  console.log(renderFlowHeader());
  console.log(renderDivider());
  for (const t of flow) {
    console.log(renderFlowRow(t.variant!));
  }
  console.log("");
}
if (unitCount > 0) {
  console.log(pc.dim(`Unit tests: ${unitCount}`));
  console.log("");
}
console.log(
  pc.dim(`(re-run with VITEST_SEED=${SEED} bun run test to reproduce order)`),
);
console.log("");

// Now run.
const run = spawn("bunx", ["vitest", "run"], { stdio: "inherit" });
run.on("exit", (code) => process.exit(code ?? 1));
