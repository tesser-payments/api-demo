import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { authenticate, get } from "../../src/client.ts";
import { SHARED_STATE_LOG_PATH, type SharedAction } from "../shared-state.ts";

export const NETWORKS_FILE_PATH = join(
  process.env.TMPDIR || "/tmp",
  "api-demo-networks.json",
);

export interface NetworkInfo {
  key: string;
  name?: string;
}

// Vitest globalSetup runs once per process (in main, not in test workers).
// Responsibilities:
//   - Truncate the shared-state action log so each run starts fresh.
//   - Authenticate and fetch /v1/networks; write the list to a file the
//     flow tests can read synchronously at module load time for test.each.
//   - On teardown, print the shared-state action summary.
export default async function setup() {
  // Truncate any previous shared-state action log.
  try {
    if (existsSync(SHARED_STATE_LOG_PATH)) unlinkSync(SHARED_STATE_LOG_PATH);
  } catch {
    // Non-fatal.
  }

  // Fetch supported networks once for parameterized flow tests.
  try {
    await authenticate();
    const res = await get<{ data: NetworkInfo[] }>("/v1/networks");
    writeFileSync(NETWORKS_FILE_PATH, JSON.stringify(res.data, null, 2));
    console.log(
      pc.dim(
        `[setup] wrote ${res.data.length} networks to ${NETWORKS_FILE_PATH}`,
      ),
    );
  } catch (err) {
    // Don't fail the whole suite over this — flow tests can fall back to a
    // single hardcoded network if the file is missing.
    console.warn(
      pc.yellow(
        `[setup] failed to fetch /v1/networks: ${err instanceof Error ? err.message : err}. ` +
          "Flow tests that need network variants will fall back to STELLAR only.",
      ),
    );
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
