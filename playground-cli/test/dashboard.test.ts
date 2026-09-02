import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WithdrawalDashboard } from "../src/dashboard.ts";

describe("withdrawal dashboard", () => {
  test("renders a sanitized sequence diagram with ordered steps", () => {
    const directory = mkdtempSync(join(tmpdir(), "playground-dashboard-"));
    const path = join(directory, "index.html");
    const dashboard = new WithdrawalDashboard(path);
    dashboard.start();
    dashboard.updateWithdrawal({
      id: "withdrawal-id",
      organization_reference_id: "reference",
      balance_status: "reserved",
      created_at: "2026-09-01T18:17:30.147Z",
      updated_at: "2026-09-01T18:18:05.785Z",
      desired: {
        from: { amount: "107", currency: "USDC", network: "BASE_SEPOLIA" },
      },
      estimated: {
        to: { amount: "106.96", currency: "USD" },
      },
      private_key: "private-secret",
      steps: [
        {
          id: "step-2",
          step_sequence: 2,
          provider_key: "openfx",
          step_type: "swap",
          status: "created",
          estimated: {
            from: { amount: "107", currency: "USDC" },
            to: { amount: "106.96", currency: "USD" },
          },
          signature: "signature-secret",
        },
        {
          id: "step-1",
          step_sequence: 1,
          provider_key: "turnkey",
          step_type: "crypto_transfer",
          status: "failed",
          unsigned_transaction: "unsigned-secret",
          signed_at: "2026-09-01T18:17:52.863Z",
          submitted_at: null,
          failed_at: "2026-09-01T18:18:05.584Z",
          transaction_hash: "0xcomputed",
          estimated: {
            from: { amount: "107", currency: "USDC", network: "BASE_SEPOLIA" },
            to: { amount: "107", currency: "USDC" },
          },
          status_reasons: [
            {
              error_code: "transfers-9311",
              error_message: "Wait <expired> (nonce: 1)",
            },
          ],
        },
        {
          id: "step-3",
          step_sequence: 3,
          provider_key: "openfx",
          step_type: "transfer",
          status: "completed",
          completed_at: "2026-09-01T18:19:05.584Z",
          estimated: {
            from: { amount: "106.96", currency: "USD" },
            to: { amount: "106.96", currency: "USD" },
          },
        },
      ],
    });

    const html = readFileSync(path, "utf8");
    expect(html).toContain("Withdrawal sequence");
    expect(html).toContain("Playground CLI");
    expect(html).toContain("Tesser API");
    expect(html).toContain("Local signer");
    expect(html).toContain('class="event-arrow"');
    expect(html).toContain(".lane-cell::before");
    expect(html).toContain(".diagram-scroll { overflow: visible; }");
    expect(html).toContain(".event-card { --event-color: #71847d; grid-row: 1;");
    expect(html).not.toContain("overflow-x: auto");
    expect(html).not.toContain("min-width: 980px");
    expect(html).toContain("BASE_SEPOLIA");
    expect(html).toContain("Move funds from source wallet");
    expect(html).toContain("Convert funds through OpenFX");
    expect(html).toContain("Send funds to destination bank");
    expect(html).toContain('data-event-id="step-2-status-webhook"');
    expect(html).toContain('data-event-id="step-3-status-webhook"');
    expect(html).toContain("Report transfer step status");
    expect(html).toContain("Transfer step status: created");
    expect(html).toContain("Transfer step status: completed");
    expect(html).toContain("OpenFX → Tesser");
    expect(html).toContain('<span class="stage-status event-pending">created</span>');
    expect(html).toContain('<span class="stage-status event-complete">completed</span>');
    expect(html.indexOf('data-step-id="step-1"')).toBeLessThan(
      html.indexOf('data-step-id="step-2"'),
    );
    expect(html.indexOf('data-step-id="step-2"')).toBeLessThan(
      html.indexOf('data-step-id="step-3"'),
    );
    expect(html).toContain("Nonce queue timed out");
    expect(html).toContain("Locally computed transaction hash");
    expect(html).toContain("does not prove it reached the network");
    expect(html).toContain("Wait &lt;expired&gt; (nonce: 1)");
    expect(html).not.toContain("Wait <expired> (nonce: 1)");
    expect(html).not.toContain("private-secret");
    expect(html).not.toContain("signature-secret");
    expect(html).not.toContain("unsigned-secret");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("<script>");
    const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
    expect(script).toBeDefined();
    expect(() => new Function(script!)).not.toThrow();

    dashboard.complete();
    expect(readFileSync(path, "utf8")).not.toContain('http-equiv="refresh"');
  });
});
