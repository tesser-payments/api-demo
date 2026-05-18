import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  subscribeToWebhooks,
  WebhookTimeout,
  type WebhookSubscription,
} from "../../src/webhooks.ts";

interface WebhookSiteRequest {
  uuid: string;
  content: string;
  headers: Record<string, string[]>;
  created_at: string;
}

interface MockState {
  requests: WebhookSiteRequest[];
  calls: { url: string }[];
}

const realFetch = globalThis.fetch;

function makeEnvelope(opts: {
  envelopeId?: string;
  type: string;
  object: Record<string, unknown>;
  created_at?: string;
}): string {
  return JSON.stringify({
    id: opts.envelopeId ?? `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: opts.type,
    created_at: opts.created_at ?? "2026-05-18T00:00:00.000Z",
    data: { object: opts.object },
  });
}

function futureIso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function makeRequest(opts: {
  uuid?: string;
  body: string;
  signature?: string | null;
  receivedAt: string;
}): WebhookSiteRequest {
  const headers: Record<string, string[]> = {};
  if (opts.signature !== null && opts.signature !== undefined) {
    headers["x-tesser-signature"] = [opts.signature];
  }
  return {
    uuid: opts.uuid ?? `req_${Math.random().toString(36).slice(2, 10)}`,
    content: opts.body,
    headers,
    created_at: opts.receivedAt,
  };
}

function installFetchMock(state: MockState) {
  globalThis.fetch = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === "string" ? input : input.toString();
    state.calls.push({ url });
    const u = new URL(url);
    const dateFrom = u.searchParams.get("date_from");
    let data = state.requests;
    if (dateFrom) {
      const t = new Date(dateFrom).getTime();
      data = data.filter((r) => new Date(r.created_at).getTime() >= t);
    }
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof globalThis.fetch;
}

describe("subscribeToWebhooks", () => {
  let state: MockState;
  let sub: WebhookSubscription | null;

  beforeEach(() => {
    state = { requests: [], calls: [] };
    installFetchMock(state);
    sub = null;
  });

  afterEach(() => {
    sub?.stop();
    globalThis.fetch = realFetch;
  });

  test("collectAll returns events sorted by receivedAt ascending once all expected types arrive", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_1" } }),
        receivedAt: futureIso(200),
      }),
      makeRequest({
        body: makeEnvelope({ type: "payment.risk_updated", object: { id: "pay_1" } }),
        receivedAt: futureIso(100),
      }),
    );

    const events = await sub.scopedTo("pay_1").collectAll({
      expectedTypes: ["payment.quote_created", "payment.risk_updated"],
      timeoutMs: 1000,
    });

    expect(events.map((e) => e.type)).toEqual([
      "payment.risk_updated",
      "payment.quote_created",
    ]);
  });

  test("scopedTo filters out events that do not belong to the given resource ids", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_other" } }),
        receivedAt: futureIso(100),
      }),
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_target" } }),
        receivedAt: futureIso(200),
      }),
    );

    const events = await sub.scopedTo("pay_target").collectAll({
      expectedTypes: ["payment.quote_created"],
      timeoutMs: 1000,
    });

    expect(events).toHaveLength(1);
    expect((events[0]!.data.object as { id: string }).id).toBe("pay_target");
  });

  test("collectAll throws WebhookTimeout with a `missing` field listing absent types", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_1" } }),
        receivedAt: futureIso(100),
      }),
    );

    let err: unknown;
    try {
      await sub.scopedTo("pay_1").collectAll({
        expectedTypes: ["payment.quote_created", "step.confirmed", "payment.updated"],
        timeoutMs: 50,
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(WebhookTimeout);
    const t = err as WebhookTimeout;
    expect(t.missing).toEqual(["step.confirmed", "payment.updated"]);
  });

  test("waitFor returns the first matching event in scope", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_other" } }),
        receivedAt: futureIso(100),
      }),
      makeRequest({
        body: makeEnvelope({
          type: "step.signature_requested",
          object: { id: "stp_1", payment_id: "pay_target" },
        }),
        receivedAt: futureIso(200),
      }),
    );

    const event = await sub
      .scopedTo("pay_target")
      .waitFor((e) => e.type === "step.signature_requested", { timeoutMs: 1000 });

    expect(event.type).toBe("step.signature_requested");
  });

  test("waitFor throws WebhookTimeout when no matching event arrives", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    let err: unknown;
    try {
      await sub.scopedTo("pay_1").waitFor(undefined, { timeoutMs: 50 });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(WebhookTimeout);
  });

  test("requests sent after startWindow include a date_from query param", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    // Trigger one poll cycle by awaiting a quick timeout.
    let err: unknown;
    try {
      await sub.scopedTo("pay_none").waitFor(undefined, { timeoutMs: 30 });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WebhookTimeout);

    expect(state.calls.length).toBeGreaterThan(0);
    for (const c of state.calls) {
      expect(c.url).toContain("date_from=");
      expect(c.url).toContain("/token/tok/requests");
    }
  });

  test("events without a signature header are marked signatureValid=false", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_1" } }),
        signature: null,
        receivedAt: futureIso(100),
      }),
    );

    const events = await sub.scopedTo("pay_1").collectAll({
      expectedTypes: ["payment.quote_created"],
      timeoutMs: 1000,
    });

    expect(events[0]!.signature).toBeNull();
    expect(events[0]!.signatureValid).toBe(false);
  });

  test("events with a bogus signature are marked signatureValid=false", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_1" } }),
        signature: Buffer.from("not-a-real-signature").toString("base64"),
        receivedAt: futureIso(100),
      }),
    );

    const events = await sub.scopedTo("pay_1").collectAll({
      expectedTypes: ["payment.quote_created"],
      timeoutMs: 1000,
    });

    expect(events[0]!.signatureValid).toBe(false);
  });

  test("disabling signature verification leaves signatureValid=false but does not error on bogus signatures", async () => {
    sub = subscribeToWebhooks({
      token: "tok",
      pollIntervalMs: 5,
      verifySignatures: false,
    });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_1" } }),
        signature: "garbage===",
        receivedAt: futureIso(100),
      }),
    );

    const events = await sub.scopedTo("pay_1").collectAll({
      expectedTypes: ["payment.quote_created"],
      timeoutMs: 1000,
    });

    expect(events[0]!.signatureValid).toBe(false);
  });

  test("collectAll deduplicates events across multiple poll cycles", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();

    state.requests.push(
      makeRequest({
        uuid: "fixed-1",
        body: makeEnvelope({ type: "payment.quote_created", object: { id: "pay_1" } }),
        receivedAt: futureIso(100),
      }),
    );

    // Give the loop time to poll repeatedly.
    await new Promise((r) => setTimeout(r, 60));
    state.requests.push(
      makeRequest({
        uuid: "fixed-2",
        body: makeEnvelope({ type: "payment.risk_updated", object: { id: "pay_1" } }),
        receivedAt: futureIso(200),
      }),
    );

    const events = await sub.scopedTo("pay_1").collectAll({
      expectedTypes: ["payment.quote_created", "payment.risk_updated"],
      timeoutMs: 1000,
    });

    expect(events.map((e) => e.type)).toEqual([
      "payment.quote_created",
      "payment.risk_updated",
    ]);
  });

  test("stop halts the poll loop", async () => {
    sub = subscribeToWebhooks({ token: "tok", pollIntervalMs: 5 });
    sub.startWindow();
    await new Promise((r) => setTimeout(r, 30));
    const callsBeforeStop = state.calls.length;
    sub.stop();
    await new Promise((r) => setTimeout(r, 30));
    const callsAfterStop = state.calls.length;
    // Allow up to one in-flight call to complete after stop().
    expect(callsAfterStop - callsBeforeStop).toBeLessThanOrEqual(1);
  });
});
