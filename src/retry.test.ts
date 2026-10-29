import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ApiError, NetworkError, authenticate } from "./client.ts";
import { isTransient, pRetry, poll, postWithRetry, retryOpts } from "./retry.ts";

const apiError = (status: number, ...codes: string[]) =>
  new ApiError(
    "POST",
    "https://sandbox.tesserx.co/v1/x",
    status,
    JSON.stringify({ errors: codes.map((error_code) => ({ error_code, error_message: "msg" })) }),
  );

const fast = { attempts: 3, intervalMs: 1 };

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe("ApiError", () => {
  test("parses error codes from the response body", () => {
    const err = apiError(400, "treasury-3103", "treasury-3101");
    expect(err.errorCodes).toEqual(["treasury-3103", "treasury-3101"]);
    expect(err.hasCode("treasury-3101")).toBe(true);
    expect(err.hasCode("payments-3017")).toBe(false);
  });

  test("tolerates a non-JSON body and keeps the response in the message", () => {
    const err = new ApiError("GET", "https://x/v1/y", 502, "<html>Bad Gateway</html>");
    expect(err.errorCodes).toEqual([]);
    expect(err.message).toContain("GET https://x/v1/y failed (502)");
    expect(err.message).toContain("<html>Bad Gateway</html>");
  });
});

describe("isTransient", () => {
  test.each([
    ["network error", new NetworkError("GET", "https://x", new Error("ConnectionRefused")), true],
    ["5xx", apiError(502, "accounts-5001"), true],
    ["429", apiError(429), true],
    ["idempotency key still processing", apiError(409, "idempotency-0001"), true],
    ["4xx", apiError(400, "treasury-3103"), false],
    ["plain error", new Error("boom"), false],
  ])("%s", (_name, error, expected) => {
    expect(isTransient(error)).toBe(expected);
  });

  test("a listed code is transient", () => {
    expect(isTransient(apiError(400, "treasury-3103"), ["treasury-3103"])).toBe(true);
  });
});

describe("retryOpts", () => {
  test("a 4xx that isn't listed fails on the first attempt", async () => {
    const fn = mock(async () => {
      throw apiError(400, "payments-0002");
    });
    await expect(pRetry(fn, retryOpts("Test", fast))).rejects.toThrow("failed (400)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("a listed code retries until it succeeds", async () => {
    let calls = 0;
    const result = await pRetry(async () => {
      if (++calls < 3) throw apiError(400, "treasury-3103");
      return "ok";
    }, retryOpts("Test", { ...fast, retryOn: ["treasury-3103"] }));
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  test("errors the caller throws (a pRetry poll) still retry", async () => {
    const fn = mock(async () => {
      throw new Error("not yet");
    });
    await expect(pRetry(fn, retryOpts("Test", fast))).rejects.toThrow("not yet");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test("a TypeError (a bug) is not retried", async () => {
    const fn = mock(async () => {
      throw new TypeError("undefined is not an object");
    });
    await expect(pRetry(fn, retryOpts("Test", fast))).rejects.toThrow(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("postWithRetry", () => {
  let fetchSpy: ReturnType<typeof spyOn>;
  const keys: (string | null)[] = [];

  beforeEach(async () => {
    keys.length = 0;
    process.env.TESSER_CLIENT_ID ||= "test";
    process.env.TESSER_CLIENT_SECRET ||= "test";
    fetchSpy = spyOn(globalThis, "fetch");
  });
  afterEach(() => fetchSpy.mockRestore());

  // Auth, then the given responses for the POSTs, recording each Idempotency-Key.
  const respond = async (...responses: Response[]) => {
    fetchSpy.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers.Authorization) {
        keys.push(headers["Idempotency-Key"] ?? null);
        const next = responses.shift();
        if (!next) throw new Error("no more responses");
        return next;
      }
      return Response.json({ access_token: "t" });
    });
    await authenticate();
  };
  const fail = (status: number, code: string) =>
    Response.json({ errors: [{ error_code: code, error_message: "msg" }] }, { status });

  test("keeps the key across transient failures", async () => {
    await respond(fail(503, "idempotency-0003"), Response.json({ data: { id: "d1" } }));
    const res = await postWithRetry<{ data: { id: string } }>("Test", "/v1/x", {}, fast);
    expect(res.data.id).toBe("d1");
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeString();
    expect(keys[1]).toBe(keys[0]!);
  });

  test("renews the key after a listed 4xx, since the API would replay it", async () => {
    await respond(fail(400, "treasury-3103"), Response.json({ data: { id: "d1" } }));
    await postWithRetry("Test", "/v1/x", {}, { ...fast, retryOn: ["treasury-3103"] });
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]!);
  });
});

describe("poll", () => {
  test("returns the first value that isn't undefined", async () => {
    let calls = 0;
    const result = await poll("Test", async () => (++calls < 3 ? undefined : calls), {
      timeoutMs: 1_000,
      intervalMs: 1,
    });
    expect(result).toBe(3);
  });

  test("times out with the label and hint", async () => {
    await expect(
      poll("Deposit planning", async () => undefined, {
        timeoutMs: 20,
        intervalMs: 5,
        timeoutHint: "Check the Circle wire bank",
      }),
    ).rejects.toThrow(/Deposit planning timed out after \d+s\. Check the Circle wire bank/);
  });

  test("an error thrown by check stops the poll at once", async () => {
    const check = mock(async () => {
      throw new Error("Step 1 failed");
    });
    await expect(poll("Test", check, { timeoutMs: 1_000, intervalMs: 1 })).rejects.toThrow("Step 1 failed");
    expect(check).toHaveBeenCalledTimes(1);
  });

  test("transient errors are retried", async () => {
    let calls = 0;
    const result = await poll(
      "Test",
      async () => {
        if (++calls === 1) throw apiError(502);
        return "done";
      },
      { timeoutMs: 1_000, intervalMs: 1 },
    );
    expect(result).toBe("done");
    expect(calls).toBe(2);
  });
});
