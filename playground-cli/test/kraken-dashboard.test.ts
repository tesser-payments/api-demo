import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Choice, Interaction } from "../src/interaction.ts";
import { KrakenDashboard, resolveKrakenUi, type KrakenDashboardKind } from "../src/kraken-dashboard.ts";

describe("Kraken dashboards", () => {
  test("renders command-specific progress and sanitized response data", () => {
    const directory = mkdtempSync(join(tmpdir(), "playground-kraken-dashboard-"));
    const path = join(directory, "index.html");
    const dashboard = new KrakenDashboard("swap", path);

    dashboard.start();
    dashboard.update("usd-usdc", "Waiting for the Kraken market order to close", {
      orderId: "order-1",
      KRAKEN_API_KEY: "secret",
      status: "open",
    });

    let html = readFileSync(path, "utf8");
    expect(html).toContain("Kraken BRL or USD to USDC swap");
    expect(html).toContain("Waiting for the Kraken market order to close");
    expect(html).toContain("order-1");
    expect(html).toContain("&lt;redacted&gt;");
    expect(html).not.toContain("secret");
    expect(html).toContain('meta http-equiv="refresh"');

    dashboard.complete({ orderId: "order-1", status: "closed" });

    html = readFileSync(path, "utf8");
    expect(html).toContain("Kraken workflow completed");
    expect(html).toContain("closed");
    expect(html).not.toContain('meta http-equiv="refresh"');
  });

  test("prompts for every interactive Kraken dashboard with disabled as the default", async () => {
    const dashboards: Array<{ kind: KrakenDashboardKind; path: string }> = [
      { kind: "deposit", path: "ui/kraken/deposit/index.html" },
      { kind: "funding-deposit", path: "ui/kraken/funding-deposit/index.html" },
      { kind: "swap", path: "ui/kraken/swap/index.html" },
      { kind: "withdrawal", path: "ui/kraken/withdrawal/index.html" },
      { kind: "cli-only-deposit", path: "ui/kraken/cli-only/deposit/index.html" },
    ];

    for (const { kind, path } of dashboards) {
      const interaction = new DashboardInteraction(true);
      await expect(resolveKrakenUi(interaction, undefined, kind)).resolves.toBeTrue();
      expect(interaction.confirmationDefaults).toEqual([false]);
      expect(interaction.confirmationLabels[0]).toContain(path);
    }
  });

  test("uses the explicit flag without prompting and skips prompts during validation", async () => {
    const enabledInteraction = new DashboardInteraction(false);
    await expect(resolveKrakenUi(enabledInteraction, true, "deposit")).resolves.toBeTrue();
    expect(enabledInteraction.confirmationLabels).toEqual([]);

    const validationInteraction = new DashboardInteraction(true);
    await expect(resolveKrakenUi(validationInteraction, undefined, "funding-deposit", true)).resolves.toBeFalse();
    expect(validationInteraction.confirmationLabels).toEqual([]);
  });
});

class DashboardInteraction implements Interaction {
  readonly interactive = true;
  readonly confirmationDefaults: boolean[] = [];
  readonly confirmationLabels: string[] = [];

  constructor(private readonly confirmation: boolean) {}

  async text(): Promise<string> {
    throw new Error("Unexpected text prompt");
  }

  async optionalText(): Promise<string | undefined> {
    throw new Error("Unexpected optional text prompt");
  }

  async secret(): Promise<string> {
    throw new Error("Unexpected secret prompt");
  }

  async choose<T>(_label: string, choices: Choice<T>[]): Promise<T> {
    return choices[0]!.value;
  }

  async confirm(label: string, defaultValue = false): Promise<boolean> {
    this.confirmationLabels.push(label);
    this.confirmationDefaults.push(defaultValue);
    return this.confirmation;
  }

  async approve(): Promise<void> {}
}
