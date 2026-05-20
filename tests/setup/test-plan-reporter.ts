import pc from "picocolors";

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

  private printPlan(): void {
    if (this.planned.length === 0) return;
    const header = pc.bold(pc.cyan("== Planned test order =="));
    const lines = this.planned.map((t, i) => {
      const idx = String(i + 1).padStart(2);
      return `  ${idx}. ${pc.dim(t.module)}  ${t.fullName}`;
    });
    process.stderr.write("\n" + header + "\n");
    process.stderr.write(lines.join("\n") + "\n\n");
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
    const header = pc.bold(
      pc.cyan("== Final test outcomes (planned order) =="),
    );
    const lines = this.planned.map((t, i) => {
      const result = this.findTestResult(t.fullName, t.module);
      const state = result?.state;
      const duration =
        typeof result?.duration === "number"
          ? pc.dim(` (${Math.round(result.duration)}ms)`)
          : "";
      const idx = String(i + 1).padStart(2);
      return `  ${idx}. ${stateGlyph(state)} ${pc.dim(t.module)}  ${t.fullName}${duration}`;
    });
    process.stderr.write("\n" + header + "\n");
    process.stderr.write(lines.join("\n") + "\n\n");
  }
}
