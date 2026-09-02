import { readFileSync } from "node:fs";
import type { Runtime } from "../runtime.ts";
import { UsageError } from "../errors.ts";

export type RequestCommandOptions = {
  query?: string[];
  header?: string[];
  data?: string;
  dataFile?: string;
};

export async function runRequest(
  runtime: Runtime,
  methodInput: string | undefined,
  pathInput: string | undefined,
  options: RequestCommandOptions,
): Promise<void> {
  const method = (
    await runtime.interaction.text(
      "HTTP method",
      methodInput,
      runtime.interaction.interactive ? "GET" : undefined,
    )
  ).toUpperCase();
  const path = await runtime.interaction.text(
    "API path",
    pathInput,
    runtime.interaction.interactive ? "/v1/accounts" : undefined,
  );
  if (options.data !== undefined && options.dataFile !== undefined) {
    throw new UsageError("Use either --data or --data-file, not both");
  }
  let rawData = options.data;
  if (options.dataFile !== undefined) {
    try {
      rawData = options.dataFile === "-" ? await Bun.stdin.text() : readFileSync(options.dataFile, "utf8");
    } catch (cause) {
      throw new UsageError(`Could not read request body from ${options.dataFile}`, { cause });
    }
  }
  let body: unknown;
  if (rawData !== undefined) {
    try {
      body = JSON.parse(rawData);
    } catch (cause) {
      throw new UsageError("Request body is not valid JSON", { cause });
    }
  }
  const response = await runtime.client.request(method, path, {
    query: parsePairs(options.query, "Query parameter"),
    headers: Object.fromEntries(parsePairs(options.header, "Header")),
    body,
    operation: "Generic API request",
  });
  runtime.output.result({
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: response.body,
  });
  if (!response.ok) throw new UsageError(`Request failed with HTTP ${response.status}`);
}

export function parsePairs(values: string[] | undefined, label: string): Array<[string, string]> {
  return (values ?? []).map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0) throw new UsageError(`${label} must use KEY=VALUE: ${value}`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  });
}
