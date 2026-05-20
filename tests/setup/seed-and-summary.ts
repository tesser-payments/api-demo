import { existsSync, readFileSync, unlinkSync } from "node:fs";
import pc from "picocolors";
import { SHARED_STATE_LOG_PATH, type SharedAction } from "../shared-state.ts";

// Vitest globalSetup runs once per process (in main, not in test workers).
// It truncates the file-based action log at start and prints a summary at
// teardown by reading whatever workers appended.
export default function setup() {
  // Truncate any previous run's log.
  try {
    if (existsSync(SHARED_STATE_LOG_PATH)) unlinkSync(SHARED_STATE_LOG_PATH);
  } catch {
    // Non-fatal; the appendFileSync in recordAction will overwrite as needed.
  }

  return () => {
    if (!existsSync(SHARED_STATE_LOG_PATH)) {
      console.log(pc.dim("\n(no shared-state actions recorded)\n"));
      return;
    }
    const raw = readFileSync(SHARED_STATE_LOG_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length === 0) {
      console.log(pc.dim("\n(no shared-state actions recorded)\n"));
      return;
    }
    console.log("\n" + pc.bold(pc.cyan("== Shared-state action log ==")));
    for (const line of lines) {
      try {
        const a = JSON.parse(line) as SharedAction;
        const color = a.action === "CREATED" ? pc.green : pc.yellow;
        const det = a.detail ? ` (${a.detail})` : "";
        console.log(
          `  ${color(a.action.padEnd(7))} ${a.kind.padEnd(8)} ${a.id}${det}  ${pc.dim("[" + a.test + "]")}`,
        );
      } catch {
        // skip unparseable lines
      }
    }
    console.log("");
  };
}
