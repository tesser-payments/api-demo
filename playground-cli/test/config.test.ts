import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getKrakenConfiguration,
  getTesserConfiguration,
  loadEnvironment,
} from "../src/config.ts";
import { UsageError } from "../src/errors.ts";

describe("environment loading", () => {
  test("loads only an explicitly selected file", () => {
    const directory = mkdtempSync(join(tmpdir(), "playground-config-"));
    const path = join(directory, "sandbox.env");
    writeFileSync(path, "TESSER_BASE_URL=https://file.example\nTESSER_CLIENT_ID=file-id\n");

    const environment = loadEnvironment(path, {});

    expect(environment.TESSER_BASE_URL).toBe("https://file.example");
    expect(environment.TESSER_CLIENT_ID).toBe("file-id");
  });

  test("calling-process variables override the selected file", () => {
    const directory = mkdtempSync(join(tmpdir(), "playground-config-"));
    const path = join(directory, "sandbox.env");
    writeFileSync(path, "TESSER_BASE_URL=https://file.example\nTESSER_CLIENT_ID=file-id\n");

    const environment = loadEnvironment(path, {
      TESSER_BASE_URL: "https://process.example",
    });

    expect(environment.TESSER_BASE_URL).toBe("https://process.example");
    expect(environment.TESSER_CLIENT_ID).toBe("file-id");
  });

  test("does not load a file when --env-file is absent", () => {
    expect(loadEnvironment(undefined, {})).toEqual({});
  });

  test("fails for an explicitly missing file", () => {
    expect(() => loadEnvironment("/missing/playground.env", {})).toThrow(UsageError);
  });

  test("uses the base URL as the default audience", () => {
    const configuration = getTesserConfiguration({
      TESSER_BASE_URL: "https://sandbox.example",
      TESSER_AUTH_URL: "https://auth.example/oauth/token",
      TESSER_CLIENT_ID: "client-id",
      TESSER_CLIENT_SECRET: "client-secret",
    });

    expect(configuration.audience).toBe("https://sandbox.example");
    expect(configuration.timeoutSeconds).toBe(30);
  });

  test.each([undefined, "", "   "])(
    "uses the live Kraken API when the configured URL is %j",
    (baseUrl) => {
      const configuration = getKrakenConfiguration({
        KRAKEN_API_KEY: "api-key",
        KRAKEN_API_SECRET: "api-secret",
        KRAKEN_BASE_URL: baseUrl,
      });

      expect(configuration.baseUrl).toBe("https://api.kraken.com");
      expect(configuration.timeoutSeconds).toBe(30);
    },
  );

  test("uses the Kraken API URL configured by the selected environment", () => {
    const configuration = getKrakenConfiguration({
      KRAKEN_API_KEY: "api-key",
      KRAKEN_API_SECRET: "api-secret",
      KRAKEN_BASE_URL: "https://sandbox.kraken.example/",
    });

    expect(configuration.baseUrl).toBe("https://sandbox.kraken.example");
  });
});
