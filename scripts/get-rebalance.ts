import pc from "picocolors";
import { authenticate, get } from "../src/client.ts";

const REBALANCE_ID = process.env.TESSER_REBALANCE_ID;
if (!REBALANCE_ID) throw new Error("TESSER_REBALANCE_ID is not set");

async function main() {
  console.log(pc.bold("\n[1] Authenticating..."));
  await authenticate();

  console.log(pc.bold("\n[2] Getting rebalance..."));
  const response = await get(`/v1/treasury/rebalances/${REBALANCE_ID}`);

  console.log(JSON.stringify(response, null, 2));

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
