// Wraps `vitest run` with a pre-pass that prints the planned test order
// at the top of the log. Vitest 4 interleaves test collection with test
// execution, so a reporter can't print "all planned tests" before any
// have started running. Instead, we run `vitest list` first (same seed),
// format its output, print as a column table, then invoke `vitest run`.
//
// Used by `bun run test`. Strips sourcemap warnings from both passes.

import { spawn, spawnSync } from "node:child_process";
import pc from "picocolors";

const SEED = process.env.VITEST_SEED ?? String(Date.now());
process.env.VITEST_SEED = SEED;

// Column widths — match tests/setup/test-plan-reporter.ts so the planned
// panel here lines up with the final outcomes panel printed at run end.
const COL = {
  idx: 3,
  result: 7,
  doc: 32,
  provider: 11,
  currency: 8,
  network: 9,
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

function pad(s: string, width: number, right = false): string {
  return right ? s.padStart(width) : s.padEnd(width);
}

function renderHeader(): string {
  return [
    pad("#", COL.idx, true),
    pad("Result", COL.result),
    pad("Doc", COL.doc),
    pad("Provider", COL.provider),
    pad("Currency", COL.currency),
    pad("Network", COL.network),
    "Description",
  ].join("  ");
}

function renderDivider(): string {
  return [
    "-".repeat(COL.idx),
    "-".repeat(COL.result),
    "-".repeat(COL.doc),
    "-".repeat(COL.provider),
    "-".repeat(COL.currency),
    "-".repeat(COL.network),
    "-".repeat(28),
  ].join("  ");
}

function renderRow(
  idx: number,
  fullName: string,
  modulePath: string,
): string {
  const trailing = fullName.split(" > ").pop() ?? fullName;
  const v = parseVariantFromName(trailing);
  let doc: string, provider: string, currency: string, network: string, description: string;
  if (v) {
    doc = trunc(v.docSlug, COL.doc);
    provider = trunc(v.provider ?? "", COL.provider);
    currency = trunc(v.currency ?? "", COL.currency);
    network = trunc(v.network ?? "", COL.network);
    description = v.description;
  } else {
    doc = trunc(modulePath, COL.doc);
    provider = "";
    currency = "";
    network = "";
    description = fullName;
  }
  return [
    pad(String(idx), COL.idx, true),
    pad(pc.dim("·"), COL.result + pc.dim("·").length - 1),
    pad(doc, COL.doc),
    pad(provider, COL.provider),
    pad(currency, COL.currency),
    pad(network, COL.network),
    description,
  ].join("  ");
}

// Step 1: run `vitest list` to get planned tests in seed-shuffled order.
const list = spawnSync("bunx", ["vitest", "list"], { encoding: "utf8" });

if (list.status !== 0) {
  console.error("vitest list failed");
  if (list.stderr) console.error(list.stderr);
  process.exit(list.status ?? 1);
}

// Each line: "<modulepath> > <fullName>"
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
const planned = (list.stdout + (list.stderr ?? ""))
  .split("\n")
  .map(stripAnsi)
  .filter((line) => line.includes(".test.ts >"));

const rows = planned.map((line) => {
  const firstSep = line.indexOf(" > ");
  const modulePath = firstSep > 0 ? line.slice(0, firstSep) : line;
  const fullName = firstSep > 0 ? line.slice(firstSep + 3) : line;
  return { modulePath, fullName };
});

console.log("");
console.log(pc.bold(pc.cyan(`== Planned test order (VITEST_SEED=${SEED}) ==`)));
console.log(renderHeader());
console.log(renderDivider());
for (let i = 0; i < rows.length; i++) {
  console.log(renderRow(i + 1, rows[i]!.fullName, rows[i]!.modulePath));
}
console.log("");
console.log(
  pc.dim(`(re-run with VITEST_SEED=${SEED} bun run test to reproduce order)`),
);
console.log("");

// Step 2: execute the actual run, inheriting stdio so streaming output works.
const run = spawn("bunx", ["vitest", "run"], { stdio: "inherit" });
run.on("exit", (code) => process.exit(code ?? 1));
