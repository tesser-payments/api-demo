import pc from "picocolors";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { authenticate } from "../src/client.ts";

const BASE_URL = process.env.TESSER_BASE_URL || "https://sandbox.tesserx.co";
const MCP_URL = process.env.TESSER_MCP_URL || "https://sandbox.tesserx.co";

async function main() {
  console.log(pc.bold("\n[1] Authenticating..."));
  const token = await authenticate();

  console.log(pc.bold("\n[2] Connecting to MCP server..."));
  const client = new Client({ name: "api-demo", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${MCP_URL}/v1/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    },
  );
  await client.connect(transport);

  console.log(pc.bold("\n[3] Listing available tools..."));
  const { tools } = await client.listTools();
  for (const tool of tools) {
    console.log(`  ${pc.dim("·")} ${pc.cyan(tool.name)}`);
  }

  console.log(pc.bold("\n[4] Fetching networks..."));
  const networkTool = tools.find((t) =>
    t.name.toLowerCase().includes("network"),
  );
  if (!networkTool) {
    throw new Error(
      "No network tool found. Available: " +
        tools.map((t) => t.name).join(", "),
    );
  }

  const result = await client.callTool({
    name: networkTool.name,
    arguments: {},
  });
  console.log("  Result:", JSON.stringify(result.content, null, 2));

  await client.close();
  console.log(pc.bold(pc.green("\nDone!")));
}

main().catch((err) => {
  console.error(pc.red(`\nFailed: ${err.message}`));
  process.exit(1);
});
