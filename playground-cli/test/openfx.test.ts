import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { TesserClient } from "../src/http.ts";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import { deleteBasisTheory } from "../src/workflows/openfx.ts";

const token = "basis-theory-token-id";

function runtimeFor(): Runtime {
  return {
    environment: {
      BASIS_THEORY_API_KEY: "sandbox-api-key",
      BASIS_THEORY_BASE_URL: "https://basis-theory.example/",
    },
    interaction: new NonInteractiveInteraction(),
    output: new Output("json", false),
    client: {} as TesserClient,
  };
}

afterEach(() => {
  mock.restore();
});

describe("Basis Theory deletion", () => {
  test("deletes the requested token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(undefined, { status: 204 }),
    );
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await deleteBasisTheory(runtimeFor(), token);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://basis-theory.example/tokens/${token}`,
      expect.objectContaining({
        method: "DELETE",
        headers: {
          "BT-API-KEY": "sandbox-api-key",
          Accept: "application/json",
        },
      }),
    );
    expect(write.mock.calls.at(-1)?.[0]).toContain('"deleted": true');
  });

  test("treats a missing token as already deleted", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"message":"not found"}', {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const write = spyOn(process.stdout, "write").mockImplementation(() => true);

    await deleteBasisTheory(runtimeFor(), token);

    expect(write.mock.calls.at(-1)?.[0]).toContain('"alreadyDeleted": true');
  });
});
