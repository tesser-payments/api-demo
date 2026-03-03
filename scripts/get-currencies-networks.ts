import pc from "picocolors";
import { authenticate } from "../src/client.ts";

const BASE_URL = process.env.TESSER_BASE_URL || "https://sandbox.tesserx.co";

async function verboseGet(url: string, token: string): Promise<void> {
  const reqHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  console.log(pc.bold(pc.cyan(`\nGET ${url}`)));
  console.log(pc.dim("Request headers:"));
  for (const [k, v] of Object.entries(reqHeaders)) {
    const display = k === "Authorization" ? `Bearer ${v.slice(7, 27)}...` : v;
    console.log(`  ${k}: ${display}`);
  }

  const res = await fetch(url, { headers: reqHeaders });

  console.log(pc.dim(`\nResponse status: ${res.status} ${res.statusText}`));
  console.log(pc.dim("Response headers:"));
  res.headers.forEach((v, k) => {
    console.log(`  ${k}: ${v}`);
  });

  const body = await res.json();
  console.log(pc.dim("\nResponse body:"));
  console.log(JSON.stringify(body, null, 2));
}

async function main() {
  console.log(pc.bold("[1] Authenticating..."));
  const token = await authenticate();

  await verboseGet(`${BASE_URL}/v1/currencies`, token);
  await verboseGet(`${BASE_URL}/v1/networks`, token);

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
