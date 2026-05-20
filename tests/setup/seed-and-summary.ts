import pc from "picocolors";
import { sharedState } from "../shared-state.ts";

// Vitest globalSetup runs once per process. We use it to:
//   (1) Establish the test order seed (allowing replay via VITEST_SEED).
//   (2) Print the seed prominently for replication.
//   (3) On teardown, print the full shared-state action log so the run
//       can be reproduced/inspected after the fact.
export default function setup() {
  const seedFromEnv = process.env.VITEST_SEED;
  const seed = seedFromEnv ? Number(seedFromEnv) : Date.now();
  // Re-export so vitest.config.ts can pick it up.
  process.env.VITEST_SEED = String(seed);

  console.log(pc.bold(`\n${pc.cyan("==")} VITEST_SEED=${seed} ${pc.dim("(re-run with VITEST_SEED=" + seed + " to reproduce order)")}\n`));

  return () => {
    console.log("\n" + pc.bold(pc.cyan("== Final shared-state summary ==")));
    console.log(sharedState.summary());
    console.log(pc.dim(`(VITEST_SEED=${seed})\n`));
  };
}
