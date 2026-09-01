import { describe, expect, test } from "bun:test";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { UsageError } from "../src/errors.ts";

describe("non-interactive mode", () => {
  const interaction = new NonInteractiveInteraction();

  test("returns provided input without prompting", async () => {
    expect(await interaction.text("Value", "provided")).toBe("provided");
    expect(await interaction.optionalText("Optional", "provided")).toBe("provided");
    expect(await interaction.optionalText("Optional")).toBeUndefined();
    expect(await interaction.confirm("Confirm")).toBeFalse();
    expect(await interaction.confirm("Confirm", true)).toBeTrue();
    expect(await interaction.secret("Secret", "secret")).toBe("secret");
  });

  test("fails when required input is absent", async () => {
    await expect(interaction.text("Value")).rejects.toBeInstanceOf(UsageError);
    await expect(interaction.secret("Secret")).rejects.toBeInstanceOf(UsageError);
  });

  test("selects one unambiguous choice", async () => {
    await expect(
      interaction.choose("Account", [{ name: "One", value: "one" }]),
    ).resolves.toBe("one");
    await expect(
      interaction.choose("Account", [
        { name: "One", value: "one" },
        { name: "Two", value: "two" },
      ]),
    ).rejects.toBeInstanceOf(UsageError);
  });
});
