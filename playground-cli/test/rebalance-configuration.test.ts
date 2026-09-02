import { describe, expect, mock, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import type { HttpResponse, TesserClient } from "../src/http.ts";
import type { Choice, Interaction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import {
  configureRebalanceEnvironment,
  resolveRebalanceUi,
  type RebalanceEnvironment,
} from "../src/workflows/rebalance.ts";

class RebalanceInteraction implements Interaction {
  readonly interactive = true;
  readonly textDefaults: Array<string | undefined> = [];
  readonly choiceNames: string[][] = [];
  readonly confirmationDefaults: boolean[] = [];
  readonly confirmationLabels: string[] = [];

  constructor(
    private readonly selections: string[],
    private readonly textAnswers: string[] = [],
    private readonly optionalTextAnswers: Array<string | undefined> = [],
    private readonly confirmationAnswers: boolean[] = [],
  ) {}

  async text(_label: string, _value?: string, defaultValue?: string): Promise<string> {
    this.textDefaults.push(defaultValue);
    return this.textAnswers.shift() ?? defaultValue ?? "";
  }

  async optionalText(_label: string, defaultValue?: string): Promise<string | undefined> {
    return this.optionalTextAnswers.shift() ?? defaultValue;
  }

  async secret(): Promise<string> {
    throw new Error("Unexpected secret prompt");
  }

  async choose<T>(_label: string, choices: Choice<T>[]): Promise<T> {
    this.choiceNames.push(choices.map((choice) => choice.name));
    const selection = this.selections.shift();
    const selectedChoice = choices.find((choice) => choice.value === selection);
    if (!selectedChoice) throw new Error(`Choice not found: ${selection}`);
    return selectedChoice.value;
  }

  async confirm(label: string, defaultValue = false): Promise<boolean> {
    this.confirmationLabels.push(label);
    this.confirmationDefaults.push(defaultValue);
    return this.confirmationAnswers.shift() ?? defaultValue;
  }

  async approve(): Promise<void> {
    throw new Error("Unexpected approval prompt");
  }
}

describe("rebalance configuration", () => {
  test("prompts for the rebalance UI with disabled as the default", async () => {
    const interaction = new RebalanceInteraction([], [], [], [true]);

    await expect(resolveRebalanceUi(runtimeFor(interaction), {})).resolves.toBeTrue();
    expect(interaction.confirmationDefaults).toEqual([false]);
    expect(interaction.confirmationLabels).toEqual([
      "Enable UI? (Creates ui/rebalance/index.html for live progress)",
    ]);
  });

  test("uses the explicit UI flag without prompting", async () => {
    const interaction = new RebalanceInteraction([]);

    await expect(
      resolveRebalanceUi(runtimeFor(interaction), { withUi: true }),
    ).resolves.toBeTrue();
    expect(interaction.confirmationDefaults).toEqual([]);
  });

  test("edits rebalance values and keeps automatic account selection", async () => {
    const interaction = new RebalanceInteraction(
      ["amount", "fromNetwork", "sourceWalletId", "destinationLedgerId", "continue"],
      ["250", "base"],
      [undefined, undefined],
    );
    const environment = rebalanceEnvironment();

    await configureRebalanceEnvironment(runtimeFor(interaction), environment);

    expect(environment.amount).toBe("250");
    expect(environment.fromNetwork).toBe("BASE");
    expect(environment.sourceWalletId).toBeUndefined();
    expect(environment.destinationLedgerId).toBeUndefined();
    expect(interaction.textDefaults).toEqual(["100", "BASE_SEPOLIA"]);
    expect(interaction.choiceNames.at(-1)?.[0]).toBe("Use these values");
  });
});

function rebalanceEnvironment(): RebalanceEnvironment {
  return {
    amount: "100",
    fromCurrency: "USDC",
    fromNetwork: "BASE_SEPOLIA",
    toCurrency: "USD",
    organizationReferenceId: "rebalance-reference",
    pollIntervalSeconds: 3,
    timeoutSeconds: 1800,
  };
}

function runtimeFor(interaction: Interaction): Runtime {
  return {
    environment: {} as Environment,
    interaction,
    output: new Output("human", false),
    client: {
      configuration: {
        baseUrl: "https://sandbox.example",
        authUrl: "https://auth.example/oauth/token",
      },
      authenticate: mock(async () => "token"),
      request: mock(async () => ({}) as HttpResponse),
    } as unknown as TesserClient,
  };
}
