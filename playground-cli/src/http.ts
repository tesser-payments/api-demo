import { ApiError, UsageError } from "./errors.ts";
import type { Output } from "./output.ts";
import type { TesserConfiguration } from "./config.ts";

export type HttpResponse = {
  ok: boolean;
  status: number;
  statusText: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
};

export type RequestOptions = {
  query?: Array<[string, string]>;
  headers?: Record<string, string>;
  body?: unknown;
  operation?: string;
};

export class TesserClient {
  private accessToken?: string;

  constructor(
    readonly configuration: TesserConfiguration,
    private readonly output: Output,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async authenticate(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const body = new URLSearchParams({
      client_id: this.configuration.clientId,
      client_secret: this.configuration.clientSecret,
      audience: this.configuration.audience,
      grant_type: "client_credentials",
    });
    let response: Response;
    try {
      response = await this.fetchImplementation(this.configuration.authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(this.configuration.timeoutSeconds * 1000),
      });
    } catch (cause) {
      throw new ApiError("Authentication request failed", undefined, undefined, { cause });
    }
    const responseBody = await parseResponseBody(response);
    this.output.exchange(
      "Authenticate",
      {
        method: "POST",
        url: this.configuration.authUrl,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: Object.fromEntries(body),
      },
      { status: response.status, body: responseBody },
    );
    if (!response.ok) {
      throw new ApiError(`Authentication failed with HTTP ${response.status}`, response.status, responseBody);
    }
    if (!responseBody || typeof responseBody !== "object") {
      throw new ApiError("Authentication response was not a JSON object", response.status, responseBody);
    }
    const token = (responseBody as Record<string, unknown>).access_token;
    if (typeof token !== "string" || !token) {
      throw new ApiError("Authentication response did not contain access_token", response.status, responseBody);
    }
    this.accessToken = token;
    return token;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<HttpResponse> {
    if (/^https?:\/\//i.test(path)) {
      throw new UsageError("Request path must be relative to TESSER_BASE_URL");
    }
    const url = new URL(path.replace(/^\//, ""), `${this.configuration.baseUrl}/`);
    for (const [name, value] of options.query ?? []) url.searchParams.append(name, value);
    const headers = new Headers({
      Accept: "application/json",
      Authorization: `Bearer ${await this.authenticate()}`,
      ...options.headers,
    });
    let requestBody: string | undefined;
    if (options.body !== undefined) {
      headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
      requestBody = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(this.configuration.timeoutSeconds * 1000),
      });
    } catch (cause) {
      throw new ApiError(`${method} ${url} failed`, undefined, undefined, { cause });
    }
    const body = await parseResponseBody(response);
    const result = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      url: String(url),
      body,
      headers: Object.fromEntries(response.headers),
    };
    this.output.exchange(
      options.operation ?? `${method} ${path}`,
      { method, url: String(url), headers: Object.fromEntries(headers), body: options.body },
      { status: response.status, headers: result.headers, body },
    );
    return result;
  }
}

export async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function requireSuccess(response: HttpResponse, operation: string): unknown {
  if (!response.ok) {
    throw new ApiError(`${operation} failed with HTTP ${response.status}`, response.status, response.body);
  }
  return response.body;
}

export function requireData<T>(response: HttpResponse, operation: string): T {
  const body = requireSuccess(response, operation);
  if (!body || typeof body !== "object" || !("data" in body)) {
    throw new ApiError(`${operation} response did not contain data`, response.status, body);
  }
  return (body as { data: T }).data;
}
