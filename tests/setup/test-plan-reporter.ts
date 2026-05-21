import pc from "picocolors";

// Vitest 4 reporter. Output is intentionally minimal — the only thing
// that prints during the run itself is per-test pass/fail (one line per
// test, not per-stdout). At end, we render two things:
//   1. Flow test matrix: one row per how-to × provider × currency × network
//   2. Unit-test one-liner
// The intent is that the matrix stays the prominent thing.

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

interface TestRunResult {
  state?: string;
  duration?: number;
  errors?: { message?: string }[];
}

interface TestCaseLike {
  type: "test";
  name: string;
  fullName: string;
  module: { relativeModuleId: string };
  result?: () => TestRunResult | undefined;
}

interface TestCollectionLike {
  allTests(): Generator<TestCaseLike, undefined, void>;
}

interface TestModuleLike {
  relativeModuleId: string;
  children: TestCollectionLike;
}

const COL = {
  doc: 38,
  provider: 12,
  currency: 9,
  network: 14,
  description: 32,
};

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function stateGlyph(state: string | undefined): string {
  switch (state) {
    case "passed":
    case "pass":
      return pc.green("✓");
    case "failed":
    case "fail":
      return pc.red("✗");
    case "skipped":
    case "skip":
      return pc.yellow("○");
    default:
      return pc.dim("·");
  }
}

function renderFlowHeader(): string {
  return [
    "       ", // glyph + spaces
    pad("Doc", COL.doc),
    pad("Provider", COL.provider),
    pad("Currency", COL.currency),
    pad("Network", COL.network),
    "Description",
  ].join("  ");
}

function renderDivider(): string {
  return [
    "-------",
    "-".repeat(COL.doc),
    "-".repeat(COL.provider),
    "-".repeat(COL.currency),
    "-".repeat(COL.network),
    "-".repeat(COL.description),
  ].join("  ");
}

function renderFlowRow(
  variant: ParsedVariant,
  state: string | undefined,
  durationMs?: number,
): string {
  const dur =
    typeof durationMs === "number"
      ? pc.dim(`  ${Math.round(durationMs / 1000)}s`)
      : "";
  return [
    `  ${stateGlyph(state)}   `,
    pad(trunc(variant.docSlug, COL.doc), COL.doc),
    pad(trunc(variant.provider ?? "-", COL.provider), COL.provider),
    pad(trunc(variant.currency ?? "-", COL.currency), COL.currency),
    pad(trunc(variant.network ?? "-", COL.network), COL.network),
    variant.description + dur,
  ].join("  ");
}

interface FlowOutcome {
  variant: ParsedVariant;
  state?: string;
  duration?: number;
}

export default class TestPlanReporter {
  private flowOutcomes: FlowOutcome[] = [];
  private unitPassed = 0;
  private unitFailed = 0;
  private unitSkipped = 0;

  onTestCaseResult(testCase: TestCaseLike): void {
    const trailing = testCase.fullName.split(" > ").pop() ?? testCase.fullName;
    const variant = parseVariantFromName(trailing);
    const result = testCase.result ? testCase.result() : undefined;
    const state = result?.state;
    const duration = result?.duration;

    if (variant) {
      this.flowOutcomes.push({ variant, state, duration });
      // Echo a single line for live feedback during long flow runs.
      process.stderr.write(
        renderFlowRow(variant, state, duration) + "\n",
      );
      if (state === "failed" || state === "fail") {
        for (const e of result?.errors ?? []) {
          if (e.message) {
            process.stderr.write(
              pc.red(`         ↳ ${e.message.split("\n")[0]}\n`),
            );
          }
        }
      }
    } else {
      // Unit test — count, no per-test echo
      if (state === "passed" || state === "pass") this.unitPassed += 1;
      else if (state === "failed" || state === "fail") this.unitFailed += 1;
      else if (state === "skipped" || state === "skip") this.unitSkipped += 1;
    }
  }

  onTestRunEnd(_modules?: ReadonlyArray<TestModuleLike>): void {
    process.stderr.write("\n");
    if (this.flowOutcomes.length > 0) {
      process.stderr.write(
        pc.bold(pc.cyan("== Flow test results ==")) + "\n",
      );
      process.stderr.write(renderFlowHeader() + "\n");
      process.stderr.write(renderDivider() + "\n");
      for (const o of this.flowOutcomes) {
        process.stderr.write(renderFlowRow(o.variant, o.state, o.duration) + "\n");
      }
      process.stderr.write("\n");
    }
    const unitTotal = this.unitPassed + this.unitFailed + this.unitSkipped;
    if (unitTotal > 0) {
      const passed = pc.green(`${this.unitPassed} passed`);
      const failed =
        this.unitFailed > 0 ? `, ${pc.red(`${this.unitFailed} failed`)}` : "";
      const skipped =
        this.unitSkipped > 0
          ? `, ${pc.yellow(`${this.unitSkipped} skipped`)}`
          : "";
      process.stderr.write(`Unit tests: ${passed}${failed}${skipped}\n`);
    }
  }
}
