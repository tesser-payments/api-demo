const BASE_URL = process.env.TESSER_BASE_URL || "https://sandbox.tesserx.co";
const AUTH_URL =
  process.env.TESSER_AUTH_URL ||
  "https://dev-awqy75wdabpsnsvu.us.auth0.com/oauth/token";
const CLIENT_ID = process.env.TESSER_CLIENT_ID;
const CLIENT_SECRET = process.env.TESSER_CLIENT_SECRET;

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
    throw new Error(`Auth failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as { access_token: string };
  token = json.access_token;
  return token;
}

/**
 * GET request to the Tesser API.
 */
export async function get<T = unknown>(path: string): Promise<T> {
  if (!token) throw new Error("Not authenticated — call authenticate() first");

  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ${path} failed (${res.status}): ${text}`);
  }

  return (await res.json()) as T;
}

/**
 * POST request to the Tesser API.
 */
export async function post<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  // TODO: fetch POST BASE_URL + path with JSON body and Authorization header
  throw new Error("TODO: implement post()");
}

/**
 * PATCH request to the Tesser API.
 */
export async function patch<T = unknown>(
  path: string,
  body: unknown,
): Promise<T> {
  // TODO: fetch PATCH BASE_URL + path with JSON body and Authorization header
  throw new Error("TODO: implement patch()");
}
