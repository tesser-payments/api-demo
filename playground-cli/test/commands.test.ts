import { describe, expect, test } from "bun:test";

const decoder = new TextDecoder();

function run(...arguments_: string[]) {
  return Bun.spawnSync({
    cmd: ["./cli", ...arguments_],
    cwd: new URL("..", import.meta.url).pathname,
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("command hierarchy", () => {
  test("shows resource commands and hides compatibility paths", () => {
    const result = run("--help");
    const output = decoder.decode(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(output).toContain("treasury");
    expect(output).toContain("accounts");
    expect(output).toContain("workspace");
    expect(output).toContain("provider-experiments");
    expect(output).not.toContain("\n  withdrawal");
    expect(output).not.toContain("\n  rebalance");
    expect(output).not.toContain("\n  kraken");
    expect(output).not.toContain("\n  tempo");
  });

  test("checks payment prerequisites before operation inputs", () => {
    const result = run("--non-interactive", "payment", "create");
    const output = decoder.decode(result.stderr);

    expect(result.exitCode).toBe(2);
    expect(output).toContain("Cannot run Payment.");
    expect(output).toContain("- TESSER_CLIENT_SECRET");
    expect(output).toContain("- SIGNING_PRIVATE_KEY");
    expect(output).not.toContain("Payment amount must be provided");
  });
});
