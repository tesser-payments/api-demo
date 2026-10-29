const BASE_URL = process.env.TESSER_BASE_URL || "https://sandbox.tesserx.co";
const AUTH_URL =
  process.env.TESSER_AUTH_URL ||
  "https://dev-awqy75wdabpsnsvu.us.auth0.com/oauth/token";
export const DEBUG = !!process.env.DEBUG_MODE && process.env.DEBUG_MODE !== "0" && process.env.DEBUG_MODE.toLowerCase() !== "false";

let token: string | null = null;

/**
 * A non-2xx response from the Tesser API. `errorCodes` come from the
 * `{ errors: [{ error_code, error_message }] }` response body.
 */
export class ApiError extends Error {
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly errorCodes: string[];

  constructor(
    method: string,
    url: string,
    status: number,
    responseText: string,
    requestBody?: string,
  ) {
    super(
      `${method} ${url} failed (${status})` +
        (requestBody === undefined ? "" : `\n  Request body: ${requestBody}`) +
        `\n  Response:     ${responseText}`,
    );
    this.name = "ApiError";
    this.method = method;
    this.url = url;
    this.status = status;
    this.errorCodes = parseErrorCodes(responseText);
  }

  hasCode(...codes: readonly string[]): boolean {
    return this.errorCodes.some((code) => codes.includes(code));
  }
}

/**
 * The request never got an HTTP response (DNS failure, connection refused or
 * reset). Bun reports these as a plain `Error`, so wrap them to tell them apart.
 */
export class NetworkError extends Error {
  constructor(method: string, url: string, cause: unknown) {
    super(
      `${method} ${url} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "NetworkError";
  }
}

function parseErrorCodes(responseText: string): string[] {
  try {
    const body = JSON.parse(responseText) as { errors?: unknown };
    if (!Array.isArray(body.errors)) return [];
    return body.errors
      .map((e: { error_code?: unknown }) => e?.error_code)
      .filter((code): code is string => typeof code === "string");
  } catch {
    return [];
  }
}

/**
 * Authenticate via OAuth2 client_credentials and store the bearer token.
 */
export async function authenticate(): Promise<string> {
  const CLIENT_ID = process.env.TESSER_CLIENT_ID;
  const CLIENT_SECRET = process.env.TESSER_CLIENT_SECRET;
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Missing TESSER_CLIENT_ID or TESSER_CLIENT_SECRET in environment",
    );
  }

  if (DEBUG) {
    console.log("[DEBUG] POST", AUTH_URL, { client_id: CLIENT_ID, audience: BASE_URL, grant_type: "client_credentials" });
  }

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      audience: BASE_URL,
      grant_type: "client_credentials",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Auth POST ${AUTH_URL} failed (${res.status})\n  Response: ${text}`,
    );
  }

  const json = (await res.json()) as { access_token: string };
  if (DEBUG) console.log("[DEBUG] RESPONSE", json);
  token = json.access_token;
  return token;
}

async function request<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  if (!token) throw new Error("Not authenticated — call authenticate() first");

  const url = `${BASE_URL}${path}`;
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (DEBUG) console.log(`[DEBUG] ${method}`, url, ...(body === undefined ? [] : [body]));

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      body: serialized,
    });
  } catch (error) {
    throw new NetworkError(method, url, error);
  }

  if (!res.ok) {
    throw new ApiError(method, url, res.status, await res.text(), serialized);
  }

  const json = (await res.json()) as T;
  if (DEBUG) console.log("[DEBUG] RESPONSE", JSON.stringify(json, null, 2));
  return json;
}

/**
 * GET request to the Tesser API.
 */
export async function get<T = unknown>(path: string): Promise<T> {
  return request<T>("GET", path);
}

/**
 * POST request to the Tesser API. With `idempotencyKey`, a repeat of the same
 * key and body replays the first response instead of executing again.
 */
export async function post<T = unknown>(
  path: string,
  body: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = opts.idempotencyKey
    ? { "Idempotency-Key": opts.idempotencyKey }
    : {};
  return request<T>("POST", path, body, headers);
}

/**
 * Paginated GET — fetches all pages and returns a flat array.
 */
export async function getAll<T>(path: string): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  const separator = path.includes("?") ? "&" : "?";
  while (true) {
    const res = await get<{ data: T[]; pagination?: { has_next: boolean } }>(
      `${path}${separator}limit=100&page=${page}`,
    );
    all.push(...res.data);
    if (!res.pagination?.has_next) break;
    page++;
  }
  return all;
}

/**
 * PATCH request to the Tesser API.
 */
export async function patch<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  return request<T>("PATCH", path, body);
}
