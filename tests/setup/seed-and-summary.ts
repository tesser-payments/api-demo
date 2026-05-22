import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { loadEnv } from "vite";
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
  // Vitest's test.env injects vars into workers only. globalSetup runs in
  // the main process and needs its own loadEnv pass.
  const env = loadEnv("test", process.cwd(), "");
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }

  // Atomically truncate the action log so previous runs don't bleed in.
  // Use writeFileSync rather than unlinkSync because unlinkSync can fail
  // silently if a stale process still holds the inode.
  try {
    writeFileSync(SHARED_STATE_LOG_PATH, "");
  } catch {
    // Non-fatal — the log just gets appended-to.
  }

  // Fetch supported networks once for parameterized flow tests.
  // Dynamic import so client.ts captures the env vars we just populated;
  // a top-level import would freeze them at module load (before loadEnv).
  const fallbackNetworks: NetworkInfo[] = [{ key: "STELLAR" }];
  // Reset before fetch so a previous run's file cannot leak across runs.
  writeFileSync(NETWORKS_FILE_PATH, JSON.stringify(fallbackNetworks, null, 2));
  try {
    const { authenticate, get } = await import("../../src/client.ts");
    await authenticate();
    const res = await get<{ data: NetworkInfo[] }>("/v1/networks");
    writeFileSync(NETWORKS_FILE_PATH, JSON.stringify(res.data, null, 2));
    console.log(
      pc.dim(
        `[setup] wrote ${res.data.length} networks to ${NETWORKS_FILE_PATH}`,
      ),
    );
  } catch (err) {
    // Fallback file already written above; just warn.
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

    // Parse all actions.
    const actions: SharedAction[] = [];
    for (const line of lines) {
      try {
        actions.push(JSON.parse(line) as SharedAction);
      } catch {
        // skip unparseable lines
      }
    }

    // Group by resource id, preserving insertion order.
    const byId = new Map<string, SharedAction[]>();
    for (const a of actions) {
      if (!byId.has(a.id)) byId.set(a.id, []);
      byId.get(a.id)!.push(a);
    }

    console.log("\n" + pc.bold(pc.cyan("== Resources used ==")));
    console.log("");

    for (const [id, entries] of byId) {
      const shortId = id.slice(0, 8);
      // Prefer the CREATED entry's metadata, but fall back to any entry's
      // metadata so REUSED-only resources (e.g., the pre-existing workspace
      // ledger) still get a proper header annotation.
      const created = entries.find((e) => e.action === "CREATED");
      const meta = created ?? entries.find((e) => e.provider || e.currency) ?? entries[0];

      const kind = entries[0]?.kind ?? "resource";
      const headerParts: string[] = [`${kind} ${shortId}`];
      if (meta?.provider || meta?.currency) {
        const metaCols: string[] = [];
        if (meta.provider) metaCols.push(meta.provider);
        if (meta.currency) metaCols.push(meta.currency);
        headerParts.push(metaCols.join(" "));
      }
      const scope = meta?.scope ?? "workspace";
      let scopeLabel = scope;
      if (meta?.tenantId) scopeLabel += ` ${meta.tenantId.slice(0, 8)}`;
      headerParts.push(scopeLabel);

      console.log(pc.bold(headerParts.join("   ")));

      for (const e of entries) {
        const color = e.action === "CREATED" ? pc.green : pc.yellow;
        console.log(`  ${color(e.action.padEnd(7))}  ${e.test}`);
        if (e.operationKind && e.operationId) {
          const summary = e.operationSummary ? `: ${e.operationSummary}` : "";
          console.log(`           → ${e.operationKind} ${e.operationId.slice(0, 8)}${summary}`);
        }
      }
      console.log("");
    }
  };
}
