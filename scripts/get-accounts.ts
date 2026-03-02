import pc from "picocolors";
import { authenticate, get } from "./src/client.ts";

type Account = {
  id: string;
  name: string;
  workspace_id: string;
  entity_id: string;
  type: string;
  is_managed: boolean;
};

type PageResponse = {
  data: Account[];
  pagination?: Record<string, unknown>;
};

async function main() {
  console.log(pc.bold("\n[1] Authenticating..."));
  await authenticate();

  console.log(pc.bold("\n[2] Fetching all accounts..."));
  const accounts: Account[] = [];
  let page = 1;
  while (true) {
    const res = await get<PageResponse>(`/v1/accounts?limit=100&page=${page}`);
    accounts.push(...res.data);
    console.log(
      `\n  ${pc.bold(`Page ${page}`)}: ${res.data.length} accounts` +
        `  | pagination: ${pc.yellow(JSON.stringify(res.pagination))}`,
    );
    if (!(res.pagination as { has_next?: boolean })?.has_next) break;
    page++;
  }

  console.log(`\n  Total: ${pc.cyan(String(accounts.length))} accounts\n`);

  for (const a of accounts) {
    console.log(`  ${pc.cyan(a.id)}  ${a.name}`);
    console.log(`    workspace: ${a.workspace_id}  entity: ${a.entity_id}`);
    console.log(`    type: ${a.type}  managed: ${a.is_managed}`);
  }

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
