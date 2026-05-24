import { describe, expect, test } from "vitest";
import { retryUntilSettled, waitUntil, WaitTimeout } from "../../src/wait.ts";

describe("waitUntil", () => {
  test("returns the value as soon as predicate is true", async () => {
    let calls = 0;
    const result = await waitUntil(
      async () => ++calls,
      (n) => n >= 3,
      { timeoutMs: 1_000, intervalMs: 5 },
    );
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });

  test("returns on the very first attempt when already satisfied", async () => {
    let calls = 0;
    const result = await waitUntil(
      async () => {
        calls += 1;
        return "ready";
      },
      (v) => v === "ready",
      { timeoutMs: 1_000, intervalMs: 100 },
    );
    expect(result).toBe("ready");
    expect(calls).toBe(1);
  });

  test("throws WaitTimeout when the predicate stays false past the deadline", async () => {
    let calls = 0;
    try {
      await waitUntil(
        async () => {
          calls += 1;
          return "still-pending";
        },
        () => false,
        { timeoutMs: 30, intervalMs: 5, describe: "the thing" },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WaitTimeout);
      const wt = err as WaitTimeout;
      expect(wt.message).toContain("the thing");
      expect(wt.describe).toBe("the thing");
      expect(wt.observedValue).toBe("still-pending");
      expect(calls).toBeGreaterThanOrEqual(2);
    }
  });

  test("propagates errors thrown by the predicate (fast-fail)", async () => {
    let calls = 0;
    await expect(
      waitUntil(
        async () => {
          calls += 1;
          return { status: "failed" } as { status: string };
        },
        (v) => {
          if (v.status === "failed") throw new Error("step failed");
          return v.status === "ready";
        },
        { timeoutMs: 1_000, intervalMs: 5 },
      ),
    ).rejects.toThrow("step failed");
    expect(calls).toBe(1);
  });

  test("propagates errors thrown by getValue (no retry)", async () => {
    let calls = 0;
    await expect(
      waitUntil(
        async () => {
          calls += 1;
          throw new Error("network glitch");
        },
        () => true,
        { timeoutMs: 1_000, intervalMs: 5 },
      ),
    ).rejects.toThrow("network glitch");
    expect(calls).toBe(1);
  });

  test("invokes onAttempt for each poll", async () => {
    const attempts: number[] = [];
    let calls = 0;
    await waitUntil(
      async () => ++calls,
      (n) => n >= 2,
      {
        timeoutMs: 1_000,
        intervalMs: 5,
        onAttempt: (n) => attempts.push(n),
      },
    );
    expect(attempts).toEqual([1, 2]);
  });
});

describe("retryUntilSettled", () => {
  test("returns immediately on first success", async () => {
    let calls = 0;
    const result = await retryUntilSettled(
      async () => {
        calls += 1;
        return "ok";
      },
      () => true,
      { timeoutMs: 1_000, intervalMs: 5 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries on retriable errors, then succeeds", async () => {
    let calls = 0;
    const result = await retryUntilSettled(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient: code-1234");
        return "settled";
      },
      (err) => err instanceof Error && err.message.includes("code-1234"),
      { timeoutMs: 1_000, intervalMs: 5 },
    );
    expect(result).toBe("settled");
    expect(calls).toBe(3);
  });

  test("rethrows non-retriable errors immediately", async () => {
    let calls = 0;
    await expect(
      retryUntilSettled(
        async () => {
          calls += 1;
          throw new Error("permanent failure");
        },
        (err) => err instanceof Error && err.message.includes("transient"),
        { timeoutMs: 1_000, intervalMs: 5 },
      ),
    ).rejects.toThrow("permanent failure");
    expect(calls).toBe(1);
  });

  test("throws WaitTimeout when retriable errors exhaust the budget", async () => {
    let calls = 0;
    try {
      await retryUntilSettled(
        async () => {
          calls += 1;
          throw new Error("always-transient");
        },
        () => true,
        { timeoutMs: 30, intervalMs: 5, describe: "the operation" },
      );
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(WaitTimeout);
      const wt = err as WaitTimeout;
      expect(wt.message).toContain("the operation");
      expect(wt.message).toContain("always-transient");
      expect(calls).toBeGreaterThanOrEqual(2);
    }
  });

  test("invokes onAttempt for each retry", async () => {
    const attempts: number[] = [];
    let calls = 0;
    await retryUntilSettled(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error("retry me");
        return "done";
      },
      () => true,
      {
        timeoutMs: 1_000,
        intervalMs: 5,
        onAttempt: (n) => attempts.push(n),
      },
    );
    expect(attempts).toEqual([1, 2]);
  });
});
