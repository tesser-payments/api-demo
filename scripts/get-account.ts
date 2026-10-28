import pc from "picocolors";
import { authenticate, get } from "../src/client.ts";
import type { Account, Envelope } from "../src/types.ts";

const ACCOUNT_ID = process.env.TESSER_FROM_ACCOUNT_ID;
if (!ACCOUNT_ID) throw new Error("TESSER_FROM_ACCOUNT_ID is not set");

async function main() {
  console.log(pc.bold("\n[1] Authenticating..."));
  await authenticate();

  console.log(pc.bold("\n[2] Getting account..."));
  const { data } = await get<Envelope<Account>>(`/v1/accounts/${ACCOUNT_ID}`);

  console.log(`  ID:       ${pc.cyan(data.id)}`);
  console.log(`  Name:     ${data.name}`);
  console.log(`  Type:     ${data.type}`);
  if (data.provider) console.log(`  Provider: ${data.provider}`);
  if (data.crypto_wallet_address) console.log(`  Address:  ${data.crypto_wallet_address}`);
  if (data.assets?.length) {
    for (const a of data.assets) {
      const net = a.network ? ` (${a.network})` : "";
      console.log(`  Asset:    ${pc.cyan(a.available_balance)} ${a.currency}${net}`);
    }
  }

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
