import { describe, expect, mock, test } from "bun:test";
import type { Environment } from "../src/config.ts";
import type { HttpResponse, TesserClient } from "../src/http.ts";
import type { Choice, Interaction } from "../src/interaction.ts";
import { Output } from "../src/output.ts";
import type { Runtime } from "../src/runtime.ts";
import {
  configureWithdrawalEnvironment,
  resolveWithdrawalUi,
  type WithdrawalEnvironment,
} from "../src/workflows/withdrawal.ts";

class WithdrawalInteraction implements Interaction {
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

  async optionalText(
    _label: string,
    defaultValue?: string,
  ): Promise<string | undefined> {
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

describe("withdrawal configuration", () => {
  test("prompts for the UI with disabled as the default", async () => {
    const interaction = new WithdrawalInteraction([], [], [], [true]);

    await expect(resolveWithdrawalUi(runtimeFor(interaction), {})).resolves.toBeTrue();
    expect(interaction.confirmationDefaults).toEqual([false]);
    expect(interaction.confirmationLabels).toEqual([
      "Enable UI? (Creates ui/withdrawal/index.html for live progress)",
    ]);
  });

  test("uses the explicit UI flag without prompting", async () => {
    const interaction = new WithdrawalInteraction([]);

    await expect(
      resolveWithdrawalUi(runtimeFor(interaction), { withUi: true }),
    ).resolves.toBeTrue();
    expect(interaction.confirmationDefaults).toEqual([]);
  });

  test("uses the current values when the default menu item is selected", async () => {
    const interaction = new WithdrawalInteraction(["continue"]);
    const environment = withdrawalEnvironment();

    await configureWithdrawalEnvironment(runtimeFor(interaction), environment);

    expect(environment).toEqual(withdrawalEnvironment());
    expect(interaction.choiceNames[0]?.[0]).toBe("Use these values");
  });

  test("edits fields with their current values as input defaults", async () => {
    const interaction = new WithdrawalInteraction(
      ["amount", "fromNetwork", "continue"],
      ["250", "base"],
    );
    const environment = withdrawalEnvironment();

    await configureWithdrawalEnvironment(runtimeFor(interaction), environment);

    expect(environment.amount).toBe("250");
    expect(environment.fromNetwork).toBe("BASE");
    expect(interaction.textDefaults).toEqual(["100", "BASE_SEPOLIA"]);
    expect(interaction.choiceNames.at(-1)?.[0]).toBe("Use these values");
    expect(interaction.choiceNames.at(-1)).toContain("Amount: 250");
  });

  test("keeps automatic account selection when an empty value is accepted", async () => {
    const interaction = new WithdrawalInteraction(
      ["sourceWalletId", "destinationBankAccountId", "continue"],
      [],
      [undefined, undefined],
    );
    const environment = withdrawalEnvironment();

    await configureWithdrawalEnvironment(runtimeFor(interaction), environment);

    expect(environment.sourceWalletId).toBeUndefined();
    expect(environment.destinationBankAccountId).toBeUndefined();
  });
});

function withdrawalEnvironment(): WithdrawalEnvironment {
  return {
    amount: "100",
    fromCurrency: "USDC",
    fromNetwork: "BASE_SEPOLIA",
    toCurrency: "USD",
    organizationReferenceId: "withdrawal-reference",
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
