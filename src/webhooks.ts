import { createPublicKey, verify } from "node:crypto";
import { WEBHOOK_PUBLIC_KEY } from "@tesser-payments/types";

export interface WebhookEvent<TObject = unknown> {
  id: string;
  type: string;
  created_at: string;
  data: { object: TObject };
  receivedAt: string;
  signature: string | null;
  signatureValid: boolean;
  rawBody: string;
}

export interface SubscribeOptions {
  token: string;
  /** webhook.site API key — required when the token is owned by a paid account. */
  apiKey?: string;
  /**
   * Ed25519 public key (base64-encoded SPKI DER) used to verify signatures.
   * Defaults to the production key from `@tesser-payments/types`. Override
   * with `WEBHOOK_SANDBOX_PUBLIC_KEY` when running against sandbox.
   */
  publicKey?: string;
  apiBaseUrl?: string;
  verifySignatures?: boolean;
  pollIntervalMs?: number;
}

export interface ScopedSubscription {
  waitFor(
    predicate?: (e: WebhookEvent) => boolean,
    opts?: { timeoutMs?: number },
  ): Promise<WebhookEvent>;
  collectAll(opts: {
    expectedTypes: readonly string[];
    timeoutMs?: number;
  }): Promise<WebhookEvent[]>;
}

export interface WebhookSubscription extends ScopedSubscription {
  startWindow(): void;
  scopedTo(ids: string | string[]): ScopedSubscription;
  stop(): void;
}

export class WebhookTimeout extends Error {
  readonly missing: string[];
  readonly observed: string[];
  readonly scopeIds: string[];

  constructor(opts: {
    message: string;
    missing: string[];
    observed: string[];
    scopeIds: string[];
  }) {
    super(opts.message);
    this.name = "WebhookTimeout";
    this.missing = opts.missing;
    this.observed = opts.observed;
    this.scopeIds = opts.scopeIds;
  }
}

const STEP_PARENT_FIELDS = [
  "payment_id",
  "deposit_id",
  "withdrawal_id",
  "rebalance_id",
  "transfer_id",
] as const;

function eventScopeIds(event: WebhookEvent): string[] {
  const obj = event.data?.object as Record<string, unknown> | undefined;
  if (!obj) return [];

  if (event.type.startsWith("step.")) {
    const ids: string[] = [];
    for (const field of STEP_PARENT_FIELDS) {
      const v = obj[field];
      if (typeof v === "string") ids.push(v);
    }
    return ids;
  }

  const id = obj.id;
  return typeof id === "string" ? [id] : [];
}

export function belongsTo(event: WebhookEvent, ids: string | string[]): boolean {
  const wanted = new Set(Array.isArray(ids) ? ids : [ids]);
  for (const id of eventScopeIds(event)) {
    if (wanted.has(id)) return true;
  }
  return false;
}

const DEFAULT_API_BASE_URL = "https://webhook.site";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_COLLECT_TIMEOUT_MS = 180_000;

interface WebhookSiteRequest {
  uuid: string;
  content: string;
  headers: Record<string, string | string[]>;
  created_at: string;
}

interface WebhookSiteResponse {
  data: WebhookSiteRequest[];
}

function extractHeader(headers: Record<string, string | string[]>, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) {
      if (Array.isArray(v)) return v[0] ?? null;
      return v ?? null;
    }
  }
  return null;
}

function buildPublicKey(keyB64: string) {
  return createPublicKey({
    key: Buffer.from(keyB64, "base64"),
    type: "spki",
    format: "der",
  });
}

function verifySignature(rawBody: string, signature: string | null, publicKey: ReturnType<typeof buildPublicKey>): boolean {
  if (!signature) return false;
  try {
    return verify(
      null,
      Buffer.from(rawBody, "utf8"),
      publicKey,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function parseEnvelope(rawBody: string): {
  id: string;
  type: string;
  created_at: string;
  data: { object: unknown };
} | null {
  try {
    const parsed = JSON.parse(rawBody);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.id === "string" &&
      typeof parsed.type === "string" &&
      typeof parsed.created_at === "string" &&
      parsed.data &&
      "object" in parsed.data
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function subscribeToWebhooks(opts: SubscribeOptions): WebhookSubscription {
  const apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const verifySignatures = opts.verifySignatures ?? true;
  const publicKey = verifySignatures
    ? buildPublicKey(opts.publicKey ?? WEBHOOK_PUBLIC_KEY)
    : null;

  let windowStart: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const seen = new Set<string>();
  const events: WebhookEvent[] = [];

  let warnedNonOk = false;
  async function pollOnce() {
    if (!windowStart) return;
    const url = `${apiBaseUrl}/token/${encodeURIComponent(opts.token)}/requests?date_from=${encodeURIComponent(windowStart)}&sorting=oldest&per_page=100`;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (opts.apiKey) headers["Api-Key"] = opts.apiKey;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      if (!warnedNonOk) {
        console.warn(`[webhooks] fetch error from webhook.site: ${err}`);
        warnedNonOk = true;
      }
      return;
    }
    if (!res.ok) {
      if (!warnedNonOk) {
        const body = await res.text().catch(() => "<unreadable>");
        console.warn(
          `[webhooks] webhook.site returned ${res.status} for poll request. ` +
            `Body: ${body.slice(0, 200)}`,
        );
        warnedNonOk = true;
      }
      return;
    }
    let body: WebhookSiteResponse;
    try {
      body = (await res.json()) as WebhookSiteResponse;
    } catch {
      return;
    }
    for (const req of body.data ?? []) {
      if (seen.has(req.uuid)) continue;
      seen.add(req.uuid);
      const envelope = parseEnvelope(req.content);
      if (!envelope) continue;
      const signature = extractHeader(req.headers ?? {}, "x-tesser-signature");
      const signatureValid =
        verifySignatures && publicKey
          ? verifySignature(req.content, signature, publicKey)
          : false;
      events.push({
        id: envelope.id,
        type: envelope.type,
        created_at: envelope.created_at,
        data: envelope.data as { object: unknown },
        receivedAt: req.created_at,
        signature,
        signatureValid,
        rawBody: req.content,
      });
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => {
      timer = null;
      await pollOnce();
      schedule();
    }, pollIntervalMs);
  }

  function startWindow() {
    // webhook.site's REST API rejects ISO 8601 with the `T` separator and
    // fractional seconds. Use its expected `YYYY-MM-DD HH:MM:SS` format (UTC).
    windowStart = new Date()
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "");
    if (timer === null && !stopped) {
      // Run a poll immediately, then schedule subsequent polls.
      timer = setTimeout(async () => {
        timer = null;
        await pollOnce();
        schedule();
      }, 0);
    }
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function makeScope(ids: string[] | null): ScopedSubscription {
    function matches(e: WebhookEvent): boolean {
      if (!ids) return true;
      return belongsTo(e, ids);
    }

    function scopedEvents(): WebhookEvent[] {
      return events.filter(matches);
    }

    async function waitFor(
      predicate?: (e: WebhookEvent) => boolean,
      opts?: { timeoutMs?: number },
    ): Promise<WebhookEvent> {
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      while (true) {
        for (const e of scopedEvents()) {
          if (!predicate || predicate(e)) return e;
        }
        if (Date.now() >= deadline) {
          const observed = Array.from(new Set(scopedEvents().map((e) => e.type)));
          throw new WebhookTimeout({
            message: `Timed out after ${timeoutMs}ms waiting for matching event. Observed in scope: [${observed.join(", ")}].`,
            missing: [],
            observed,
            scopeIds: ids ?? [],
          });
        }
        await new Promise((r) => setTimeout(r, Math.min(25, pollIntervalMs)));
      }
    }

    async function collectAll(args: {
      expectedTypes: readonly string[];
      timeoutMs?: number;
    }): Promise<WebhookEvent[]> {
      const timeoutMs = args.timeoutMs ?? DEFAULT_COLLECT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      // Build expected-count map: { type -> count }.
      const expectedCounts = new Map<string, number>();
      for (const t of args.expectedTypes) {
        expectedCounts.set(t, (expectedCounts.get(t) ?? 0) + 1);
      }
      while (true) {
        const matched = scopedEvents();
        // Tally observed counts per type.
        const observedCounts = new Map<string, number>();
        for (const e of matched) {
          observedCounts.set(e.type, (observedCounts.get(e.type) ?? 0) + 1);
        }
        // Check whether every expected type's count is satisfied.
        let satisfied = true;
        for (const [type, required] of expectedCounts) {
          if ((observedCounts.get(type) ?? 0) < required) {
            satisfied = false;
            break;
          }
        }
        if (satisfied) {
          return [...matched].sort((a, b) =>
            a.receivedAt < b.receivedAt ? -1 : a.receivedAt > b.receivedAt ? 1 : 0,
          );
        }
        if (Date.now() >= deadline) {
          const observed = Array.from(observedCounts.keys());
          // `missing` lists each under-counted type once per missing occurrence.
          const missing: string[] = [];
          for (const [type, required] of expectedCounts) {
            const have = observedCounts.get(type) ?? 0;
            for (let i = have; i < required; i++) missing.push(type);
          }
          throw new WebhookTimeout({
            message: `Waited ${timeoutMs}ms for [${[...args.expectedTypes].join(", ")}] on [${(ids ?? []).join(", ")}]; got ${matched.length} of ${args.expectedTypes.length}; missing [${missing.join(", ")}].`,
            missing,
            observed,
            scopeIds: ids ?? [],
          });
        }
        await new Promise((r) => setTimeout(r, Math.min(25, pollIntervalMs)));
      }
    }

    return { waitFor, collectAll };
  }

  const parentScope = makeScope(null);

  return {
    startWindow,
    stop,
    scopedTo(ids) {
      return makeScope(Array.isArray(ids) ? ids : [ids]);
    },
    waitFor: parentScope.waitFor,
    collectAll: parentScope.collectAll,
  };
}
