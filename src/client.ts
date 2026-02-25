const BASE_URL = process.env.TESSER_BASE_URL || "https://sandbox.tesserx.co";
const AUTH_URL =
  process.env.TESSER_AUTH_URL ||
  "https://dev-awqy75wdabpsnsvu.us.auth0.com/oauth/token";
const CLIENT_ID = process.env.TESSER_CLIENT_ID;
const CLIENT_SECRET = process.env.TESSER_CLIENT_SECRET;
const DEBUG = !!process.env.DEBUG_MODE && process.env.DEBUG_MODE !== "0";

let token: string | null = null;

/**
 * Authenticate via OAuth2 client_credentials and store the bearer token.
 */
export async function authenticate(): Promise<string> {
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

/**
 * GET request to the Tesser API.
 */
export async function get<T = unknown>(path: string): Promise<T> {
  if (!token) throw new Error("Not authenticated — call authenticate() first");

  const url = `${BASE_URL}${path}`;
  if (DEBUG) console.log("[DEBUG] GET", url);

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${url} failed (${res.status})\n  Response: ${text}`);
  }

  const json = (await res.json()) as T;
  if (DEBUG) console.log("[DEBUG] RESPONSE", json);
  return json;
}

/**
 * POST request to the Tesser API.
 */
export async function post<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  if (!token) throw new Error("Not authenticated — call authenticate() first");

  const url = `${BASE_URL}${path}`;
  const serialized = JSON.stringify(body);
  if (DEBUG) console.log("[DEBUG] POST", url, body);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: serialized,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `POST ${url} failed (${res.status})\n  Request body: ${serialized}\n  Response:     ${text}`,
    );
  }

  const json = (await res.json()) as T;
  if (DEBUG) console.log("[DEBUG] RESPONSE", json);
  return json;
}

/**
 * PATCH request to the Tesser API.
 */
export async function patch<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  if (!token) throw new Error("Not authenticated — call authenticate() first");

  const url = `${BASE_URL}${path}`;
  const serialized = JSON.stringify(body);
  if (DEBUG) console.log("[DEBUG] PATCH", url, body);

  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: serialized,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `PATCH ${url} failed (${res.status})\n  Request body: ${serialized}\n  Response:     ${text}`,
    );
  }

  const json = (await res.json()) as T;
  if (DEBUG) console.log("[DEBUG] RESPONSE", json);
  return json;
}
