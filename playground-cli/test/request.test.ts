import { describe, expect, test } from "bun:test";
import { parsePairs } from "../src/workflows/request.ts";
import { runRequest } from "../src/workflows/request.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import type { TesserClient } from "../src/http.ts";

describe("generic request parsing", () => {
  test("preserves repeated pairs and values containing equals", () => {
    expect(parsePairs(["tag=one", "tag=two", "filter=a=b"], "Query")).toEqual([
      ["tag", "one"],
      ["tag", "two"],
      ["filter", "a=b"],
    ]);
  });

  test("rejects malformed pairs", () => {
    expect(() => parsePairs(["missing"], "Query")).toThrow("KEY=VALUE");
    expect(() => parsePairs(["=value"], "Query")).toThrow("KEY=VALUE");
  });

  test("requires the method and path in non-interactive mode", async () => {
    const runtime = {
      environment: {},
      interaction: new NonInteractiveInteraction(),
      output: new Output("json", false),
      client: {} as TesserClient,
    } satisfies Runtime;

    await expect(runRequest(runtime, undefined, undefined, {})).rejects.toThrow(
      "HTTP method must be provided",
    );
  });
});
