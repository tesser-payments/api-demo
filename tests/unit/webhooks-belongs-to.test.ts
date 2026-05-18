import { describe, expect, test } from "vitest";
import { belongsTo, type WebhookEvent } from "../../src/webhooks.ts";

function makeEvent(type: string, object: Record<string, unknown>): WebhookEvent {
  return {
    id: "evt_test",
    type,
    created_at: "2026-05-18T00:00:00.000Z",
    data: { object },
    receivedAt: "2026-05-18T00:00:01.000Z",
    signature: null,
    signatureValid: false,
    rawBody: "{}",
  };
}

describe("belongsTo", () => {
  test("payment.* events match on data.object.id", () => {
    const evt = makeEvent("payment.quote_created", { id: "pay_abc" });
    expect(belongsTo(evt, "pay_abc")).toBe(true);
    expect(belongsTo(evt, "pay_other")).toBe(false);
  });

  test("step.* events match on payment_id when present", () => {
    const evt = makeEvent("step.submitted", {
      id: "stp_1",
      payment_id: "pay_abc",
    });
    expect(belongsTo(evt, "pay_abc")).toBe(true);
    expect(belongsTo(evt, "stp_1")).toBe(false);
  });

  test("step.* events fall back to deposit_id / withdrawal_id / rebalance_id / transfer_id", () => {
    expect(
      belongsTo(makeEvent("step.confirmed", { id: "stp_2", deposit_id: "dep_1" }), "dep_1"),
    ).toBe(true);
    expect(
      belongsTo(
        makeEvent("step.confirmed", { id: "stp_3", withdrawal_id: "wd_1" }),
        "wd_1",
      ),
    ).toBe(true);
    expect(
      belongsTo(
        makeEvent("step.confirmed", { id: "stp_4", rebalance_id: "rb_1" }),
        "rb_1",
      ),
    ).toBe(true);
    expect(
      belongsTo(
        makeEvent("step.confirmed", { id: "stp_5", transfer_id: "tr_1" }),
        "tr_1",
      ),
    ).toBe(true);
  });

  test("deposit/withdrawal/rebalance events match on data.object.id", () => {
    expect(belongsTo(makeEvent("deposit.created", { id: "dep_1" }), "dep_1")).toBe(true);
    expect(belongsTo(makeEvent("withdrawal.submitted", { id: "wd_1" }), "wd_1")).toBe(true);
    expect(belongsTo(makeEvent("rebalance.confirmed", { id: "rb_1" }), "rb_1")).toBe(true);
  });

  test("matches any id when passed an array", () => {
    const evt = makeEvent("payment.risk_updated", { id: "pay_b" });
    expect(belongsTo(evt, ["pay_a", "pay_b", "pay_c"])).toBe(true);
    expect(belongsTo(evt, ["pay_a", "pay_c"])).toBe(false);
  });

  test("returns false when the event has no recognized id field", () => {
    const evt = makeEvent("payment.quote_created", { other: "value" });
    expect(belongsTo(evt, "pay_abc")).toBe(false);
  });
});
