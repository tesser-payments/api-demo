import { createHash, createHmac } from "node:crypto";
import type { KrakenConfiguration } from "./config.ts";
import { ApiError } from "./errors.ts";
import type { Output } from "./output.ts";

type QueryValue = string | number | boolean | null | undefined | QueryObject;
interface QueryObject {
  [name: string]: QueryValue;
}

export type KrakenFundingRequest = {
  query?: QueryObject;
  body?: Record<string, unknown>;
  operation: string;
};

export interface KrakenFundingApi {
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    request: KrakenFundingRequest,
  ): Promise<Record<string, unknown>>;
}

export type KrakenSpotRequest = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  operation: string;
};

export interface KrakenSpotApi {
  request(
    method: "GET" | "POST",
    path: string,
    request: KrakenSpotRequest,
  ): Promise<Record<string, unknown>>;
}

export class KrakenNonce {
  private lastValue = 0;

  next(): string {
    const value = Math.max(Date.now() * 1000, this.lastValue + 1);
    this.lastValue = value;
    return String(value);
  }
}

const processKrakenNonce = new KrakenNonce();

export function createKrakenFundingSignature(
  signedPath: string,
  nonce: string,
  body: string,
  apiSecret: string,
): string {
  const digest = createHash("sha256").update(nonce).update(body).digest();
  return createHmac("sha512", Buffer.from(apiSecret, "base64"))
    .update(signedPath)
    .update(digest)
    .digest("base64");
}

export function createKrakenSpotSignature(
  path: string,
  nonce: string,
  body: string,
  apiSecret: string,
): string {
  const digest = createHash("sha256").update(nonce).update(body).digest();
  return createHmac("sha512", Buffer.from(apiSecret, "base64"))
    .update(path)
    .update(digest)
    .digest("base64");
}

export function encodeKrakenFundingQuery(query: QueryObject = {}): string {
  const parameters = new URLSearchParams();
  const addValue = (name: string, value: QueryValue): void => {
    if (value === undefined || value === null) return;
    if (typeof value === "object") {
      for (const [childName, childValue] of Object.entries(value)) {
        addValue(`${name}[${childName}]`, childValue);
      }
      return;
    }
    parameters.append(name, typeof value === "boolean" ? String(value) : `${value}`);
  };
  for (const [name, value] of Object.entries(query)) addValue(name, value);
  return parameters.toString();
}

export class KrakenFundingClient implements KrakenFundingApi {
  constructor(
    private readonly configuration: KrakenConfiguration,
    private readonly output: Output,
    private readonly requestFunction: typeof fetch = fetch,
    private readonly nonce: KrakenNonce = processKrakenNonce,
  ) {}

  async request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    request: KrakenFundingRequest,
  ): Promise<Record<string, unknown>> {
    const query = encodeKrakenFundingQuery(request.query);
    const signedPath = query ? `${path}?${query}` : path;
    const body = request.body === undefined ? "" : JSON.stringify(request.body);
    const nonce = this.nonce.next();
    const signature = createKrakenFundingSignature(
      signedPath,
      nonce,
      body,
      this.configuration.apiSecret,
    );
    const headers = {
      accept: "application/json",
      "api-key": this.configuration.apiKey,
      "api-nonce": nonce,
      "api-sign": signature,
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
    };
    const response = await this.requestFunction(`${this.configuration.baseUrl}${signedPath}`, {
      method,
      headers,
      body: request.body === undefined ? undefined : body,
      signal: AbortSignal.timeout(this.configuration.timeoutSeconds * 1000),
    });
    const responseText = await response.text();
    let responseBody: unknown = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }
    this.output.exchange(
      request.operation,
      { method, path: signedPath, headers, body: request.body },
      { status: response.status, headers: Object.fromEntries(response.headers), body: responseBody },
    );
    if (!response.ok) {
      throw new ApiError(
        `${request.operation} failed with HTTP ${response.status}`,
        response.status,
        responseBody,
      );
    }
    if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
      throw new ApiError(
        `${request.operation} response was not a JSON object`,
        response.status,
        responseBody,
      );
    }
    return responseBody as Record<string, unknown>;
  }
}

export class KrakenSpotClient implements KrakenSpotApi {
  constructor(
    private readonly configuration: KrakenConfiguration,
    private readonly output: Output,
    private readonly requestFunction: typeof fetch = fetch,
    private readonly nonce: KrakenNonce = processKrakenNonce,
  ) {}

  async request(
    method: "GET" | "POST",
    path: string,
    request: KrakenSpotRequest,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query.append(name, String(value));
    }
    const signedPath = query.size ? `${path}?${query}` : path;
    const privateRequest = path.startsWith("/0/private/");
    const nonce = privateRequest ? this.nonce.next() : undefined;
    const bodyPayload = privateRequest
      ? { ...request.body, nonce: Number(nonce) }
      : undefined;
    const body = bodyPayload ? JSON.stringify(bodyPayload) : undefined;
    const headers: Record<string, string> = privateRequest
      ? {
          accept: "application/json",
          "api-key": this.configuration.apiKey,
          "api-sign": createKrakenSpotSignature(path, nonce!, body!, this.configuration.apiSecret),
          "content-type": "application/json",
        }
      : { accept: "application/json" };
    const response = await this.requestFunction(`${this.configuration.baseUrl}${signedPath}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(this.configuration.timeoutSeconds * 1000),
    });
    const responseText = await response.text();
    let responseBody: unknown = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }
    this.output.exchange(
      request.operation,
      { method, path: signedPath, headers, body: bodyPayload },
      { status: response.status, headers: Object.fromEntries(response.headers), body: responseBody },
    );
    if (!response.ok) {
      throw new ApiError(
        `${request.operation} failed with HTTP ${response.status}`,
        response.status,
        responseBody,
      );
    }
    if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
      throw new ApiError(
        `${request.operation} response was not a JSON object`,
        response.status,
        responseBody,
      );
    }
    const krakenErrors = (responseBody as Record<string, unknown>).error;
    if (Array.isArray(krakenErrors) && krakenErrors.length) {
      throw new ApiError(
        `${request.operation} failed: ${krakenErrors.join(", ")}`,
        response.status,
        responseBody,
      );
    }
    return responseBody as Record<string, unknown>;
  }
}
