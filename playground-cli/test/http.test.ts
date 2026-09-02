import { describe, expect, mock, test } from "bun:test";
import { TesserClient } from "../src/http.ts";
import { Output } from "../src/output.ts";
import type { TesserConfiguration } from "../src/config.ts";

const configuration: TesserConfiguration = {
  baseUrl: "https://sandbox.example",
  authUrl: "https://auth.example/oauth/token",
  audience: "https://sandbox.example",
  clientId: "client-id",
  clientSecret: "client-secret",
  timeoutSeconds: 30,
};

describe("TesserClient", () => {
  test("authenticates once and preserves repeated query parameters", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = mock(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return Response.json({ access_token: "token" });
      }
      return Response.json({ data: [] });
    }) as unknown as typeof fetch;
    const client = new TesserClient(configuration, new Output("human", false), fetchImplementation);

    await client.request("GET", "/v1/accounts", {
      query: [
        ["tag", "one"],
        ["tag", "two"],
      ],
    });
    await client.request("GET", "/v1/networks");

    expect(calls).toHaveLength(3);
    expect(calls[1]!.url).toContain("tag=one&tag=two");
    expect(new Headers(calls[1]!.init?.headers).get("Authorization")).toBe("Bearer token");
    expect(calls[0]!.init?.redirect).toBe("error");
  });

  test("rejects absolute request URLs", async () => {
    const client = new TesserClient(configuration, new Output("human", false));
    await expect(client.request("GET", "https://other.example/path")).rejects.toThrow(
      "relative",
    );
  });
});
