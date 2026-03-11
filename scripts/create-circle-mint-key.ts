import pc from "picocolors";
import { authenticate, post } from "../src/client.ts";

const CIRCLE_API_KEY = process.env.CIRCLE_API_KEY;

async function main() {
  console.log(pc.bold("\n[1] Authenticating..."));
  await authenticate();
  console.log(pc.green("  ✓ Authenticated"));

  if (!CIRCLE_API_KEY) {
    console.log(pc.yellow("\n⚠️  CIRCLE_API_KEY not set in environment"));
    console.log(
      pc.dim(
        "  Set CIRCLE_API_KEY in your .env file to store it in the vault",
      ),
    );
    process.exit(0);
  }

  console.log(pc.bold("\n[2] Storing Circle Mint API key in vault..."));
  console.log(pc.dim("  Provider: CIRCLE_MINT"));
  console.log(pc.dim("  Key:      CIRCLE_MINT_API_KEY"));

  const result = await post<{ success: boolean; masked_value: string }>(
    "/v1/organizations/secrets",
    {
      provider: "CIRCLE_MINT",
      key: "CIRCLE_MINT_API_KEY",
      value: CIRCLE_API_KEY,
    },
  );

  console.log(pc.green("\n✓ Secret stored successfully!"));
  console.log(`  Success:       ${result.success}`);
  console.log(`  Masked value:  ${result.masked_value}`);

  console.log(
    pc.dim(
      "\n  The API key is now encrypted and stored in Basis Theory vault.",
    ),
  );
  console.log(
    pc.dim(
      "  It can be used by Tesser services for Circle Mint operations.",
    ),
  );

  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
