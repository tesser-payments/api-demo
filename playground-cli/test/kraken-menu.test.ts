import { describe, expect, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import type { TesserClient } from "../src/http.ts";
import type { Choice, Interaction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import type { KrakenRuntime } from "../src/workflows/kraken.ts";
import { runKrakenMenu } from "../src/workflows/kraken-menu.ts";
import { runKrakenWithdrawMenu } from "../src/workflows/kraken-withdraw.ts";

describe("Kraken menus", () => {
  test("shows balances, deposit, swap, and withdrawal navigation", async () => {
    const interaction = new BackInteraction();

    await runKrakenMenu(runtime(interaction));

    expect(interaction.labels).toEqual(["Kraken"]);
    expect(interaction.choiceNames).toEqual([
      "Register secrets",
      "BRL deposit through Tesser",
      "Balances",
      "Direct Funding API deposit",
      "Swap USD to USDC",
      "Withdraw USDC",
      "Back",
    ]);
  });

  test("keeps address registration separate from withdrawal", async () => {
    const interaction = new BackInteraction();

    await runKrakenWithdrawMenu(runtime(interaction));

    expect(interaction.labels).toEqual(["Kraken withdrawal"]);
    expect(interaction.choiceNames).toEqual([
      "Register new onchain target address",
      "Withdraw to existing target address",
      "Back",
    ]);
  });
});

class BackInteraction implements Interaction {
  readonly interactive = true;
  readonly labels: string[] = [];
  choiceNames: string[] = [];

  async text(): Promise<string> {
    throw new Error("Unexpected text prompt");
  }

  async optionalText(): Promise<string | undefined> {
    throw new Error("Unexpected optional text prompt");
  }

  async secret(): Promise<string> {
    throw new Error("Unexpected secret prompt");
  }

  async choose<T>(label: string, choices: Choice<T>[]): Promise<T> {
    this.labels.push(label);
    this.choiceNames = choices.map((choice) => choice.name);
    const back = choices.find((choice) => choice.name === "Back");
    if (!back) throw new Error("Back choice is unavailable");
    return back.value;
  }

  async confirm(): Promise<boolean> {
    throw new Error("Unexpected confirmation prompt");
  }

  async approve(): Promise<void> {
    throw new Error("Unexpected approval prompt");
  }
}

function runtime(interaction: Interaction): Runtime & KrakenRuntime {
  return {
    environment: {} as Environment,
    interaction,
    output: new Output("json", false),
    client: {} as TesserClient,
  };
}
