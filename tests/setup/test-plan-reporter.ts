import pc from "picocolors";
import { getFlowVariant, getDocSlug } from "../flow-test.ts";

// Vitest 4 reporter API. We use:
//   - onTestRunStart(specs)       — captures total module count
//   - onTestModuleCollected(mod)  — accumulates planned tests; prints plan
//                                   when every module has been collected
//   - onTestRunEnd(modules, errs, reason) — prints outcomes in planned order
//
// Reporter is duck-typed by vitest; we don't enforce the interface here.

interface PlannedTest {
  module: string;
  fullName: string;
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

// Column widths (content width, not including separator spaces)
const COL = {
  idx: 3,
  result: 7,
  doc: 32,
  provider: 11,
  currency: 8,
  network: 9,
  // description: rest of line, no truncation
};

function trunc(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function pad(s: string, width: number, right = false): string {
  if (right) return s.padStart(width);
  return s.padEnd(width);
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
    case "pending":
      return pc.dim("·");
    default:
      return pc.dim("·");
  }
}

interface RowData {
  idx: string;
  result: string;  // glyph (may contain ANSI)
  doc: string;
  provider: string;
  currency: string;
  network: string;
  description: string;
}

function buildRowData(planned: PlannedTest, idx: number, result?: string): RowData {
  // Vitest's fullName is "<describe> > <test name>"; flowTest registers
  // variants keyed by just the test name. Try the full string first, then
  // the trailing segment after the last " > ".
  const trailing = planned.fullName.split(" > ").pop() ?? planned.fullName;
  const variant =
    getFlowVariant(planned.fullName) ?? getFlowVariant(trailing);

  let doc: string;
  let provider: string;
  let currency: string;
  let network: string;
  let description: string;

  if (variant) {
    doc = trunc(getDocSlug(variant.docUrl), COL.doc);
    provider = trunc(variant.provider ?? "", COL.provider);
    currency = trunc(variant.currency ?? "", COL.currency);
    network = trunc(variant.network ?? "", COL.network);
    // Description is the test-name segment after the final " | "
    // (flowTest encodes metadata pipes before the description).
    const lastPipe = trailing.lastIndexOf(" | ");
    description = lastPipe >= 0 ? trailing.slice(lastPipe + 3) : trailing;
  } else {
    // Unit test: use the module path as doc, test name as description
    doc = trunc(planned.module, COL.doc);
    provider = "";
    currency = "";
    network = "";
    description = planned.fullName;
  }

  return {
    idx: pad(String(idx), COL.idx, true),
    result: result ?? pc.dim("·"),
    doc: pad(doc, COL.doc),
    provider: pad(provider, COL.provider),
    currency: pad(currency, COL.currency),
    network: pad(network, COL.network),
    description,
  };
}

function renderHeader(): string {
  const h = {
    idx: pad("#", COL.idx, true),
    result: pad("Result", COL.result),
    doc: pad("Doc", COL.doc),
    provider: pad("Provider", COL.provider),
    currency: pad("Currency", COL.currency),
    network: pad("Network", COL.network),
    description: "Description",
  };
  return (
    `${h.idx}  ${h.result}  ${h.doc}  ${h.provider}  ${h.currency}  ${h.network}  ${h.description}`
  );
}

function renderDivider(): string {
  return (
    `${"-".repeat(COL.idx)}  ${"-".repeat(COL.result)}  ${"-".repeat(COL.doc)}  ` +
    `${"-".repeat(COL.provider)}  ${"-".repeat(COL.currency)}  ${"-".repeat(COL.network)}  ${"-".repeat(28)}`
  );
}

function renderRow(row: RowData): string {
  return (
    `${row.idx}  ${row.result}       ${row.doc}  ${row.provider}  ${row.currency}  ${row.network}  ${row.description}`
  );
}

// The result column is a single glyph char (+ ANSI). We use 7-wide "Result"
// header but the glyph only needs 1 visible char. We pad with spaces to fill
// the visual gap in the row renderer above (using fixed spacing).
// Simpler: just build the line as a joined string.
function renderTableLine(row: RowData): string {
  // idx: right-aligned 3 chars | 2 spaces | glyph (1 visible, but ANSI-wrapped) | 7 spaces to fill result col | doc | ...
  // We keep it simple: the result glyph is 1 char wide visually. The header
  // "Result" is 6 chars. We align by putting the glyph then enough spaces.
  const resultPad = " ".repeat(COL.result - 1); // 6 spaces after the 1-char glyph
  return `${row.idx}  ${row.result}${resultPad}  ${row.doc}  ${row.provider}  ${row.currency}  ${row.network}  ${row.description}`;
}

export default class TestPlanReporter {
  private planned: PlannedTest[] = [];
  private totalModules = 0;
  private collectedModules = 0;
  private finalModules: ReadonlyArray<TestModuleLike> | undefined;

  onTestRunStart(specs: ReadonlyArray<unknown>): void {
    this.planned = [];
    this.totalModules = specs.length;
    this.collectedModules = 0;
  }

  onTestModuleCollected(testModule: TestModuleLike): void {
    this.collectedModules += 1;
    for (const t of testModule.children.allTests()) {
      this.planned.push({
        module: testModule.relativeModuleId,
        fullName: t.fullName,
      });
    }
    if (
      this.totalModules > 0 &&
      this.collectedModules === this.totalModules
    ) {
      this.printPlan();
    }
  }

  onTestRunEnd(
    modules: ReadonlyArray<TestModuleLike>,
  ): void {
    this.finalModules = modules;
    this.printOutcomes();
  }

  private printTable(title: string, rows: RowData[]): void {
    if (rows.length === 0) return;
    const header = pc.bold(pc.cyan(`== ${title} ==`));
    const lines = [
      "",
      header,
      renderHeader(),
      renderDivider(),
      ...rows.map(renderTableLine),
      "",
    ];
    process.stderr.write(lines.join("\n") + "\n");
  }

  private printPlan(): void {
    if (this.planned.length === 0) return;
    const rows = this.planned.map((t, i) =>
      buildRowData(t, i + 1, pc.dim("·")),
    );
    this.printTable("Planned test order", rows);
  }

  private findTestResult(fullName: string, moduleId: string): TestRunResult | undefined {
    if (!this.finalModules) return undefined;
    for (const m of this.finalModules) {
      if (m.relativeModuleId !== moduleId) continue;
      for (const t of m.children.allTests()) {
        if (t.fullName === fullName) {
          return t.result ? t.result() : undefined;
        }
      }
    }
    return undefined;
  }

  private printOutcomes(): void {
    if (this.planned.length === 0) return;
    const rows = this.planned.map((t, i) => {
      const result = this.findTestResult(t.fullName, t.module);
      return buildRowData(t, i + 1, stateGlyph(result?.state));
    });
    this.printTable("Final test outcomes (planned order)", rows);
  }
}
