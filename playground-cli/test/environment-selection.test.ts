import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectEnvironmentFile } from "../src/environment-selection.ts";
import { CancelledError } from "../src/errors.ts";
import type { Choice, Interaction } from "../src/interaction.ts";

class SelectionInteraction implements Interaction {
  readonly interactive = true;
  labels: string[] = [];
  displayedChoices: string[] = [];

  constructor(
    private readonly selectionName: string,
    private readonly customPath?: string,
  ) {}

  async text(label: string): Promise<string> {
    this.labels.push(label);
    if (!this.customPath) throw new Error("No custom path configured");
    return this.customPath;
  }

  async optionalText(): Promise<string | undefined> {
    throw new Error("Unexpected optional text prompt");
  }

  async secret(): Promise<string> {
    throw new Error("Unexpected secret prompt");
  }

  async choose<T>(label: string, choices: Choice<T>[]): Promise<T> {
    this.labels.push(label);
    this.displayedChoices = choices.map((choice) => choice.name);
    const selectedChoice = choices.find((choice) => choice.name === this.selectionName);
    if (!selectedChoice) throw new Error(`Choice not found: ${this.selectionName}`);
    return selectedChoice.value;
  }

  async confirm(): Promise<boolean> {
    throw new Error("Unexpected confirmation prompt");
  }

  async approve(): Promise<void> {
    throw new Error("Unexpected approval prompt");
  }
}

describe("interactive environment selection", () => {
  test("lists current-directory env files and excludes defaults and templates", async () => {
    const directory = createEnvironmentDirectory([
      "config.local.env",
      "config.sandbox.env",
      "config.example.env",
      ".env",
      ".env.local",
      "notes.txt",
    ]);
    const interaction = new SelectionInteraction("config.sandbox.env");

    const selectedPath = await selectEnvironmentFile(interaction, directory);

    expect(selectedPath).toBe(join(directory, "config.sandbox.env"));
    expect(interaction.labels).toEqual(["Which environment do you want to use?"]);
    expect(interaction.displayedChoices).toEqual([
      "config.local.env",
      "config.sandbox.env",
      "Use process environment only",
      "Enter another path",
      "Exit",
    ]);
  });

  test("prompts even when one env file is available", async () => {
    const directory = createEnvironmentDirectory(["sandbox.env"]);
    const interaction = new SelectionInteraction("sandbox.env");

    await expect(selectEnvironmentFile(interaction, directory)).resolves.toBe(
      join(directory, "sandbox.env"),
    );
    expect(interaction.labels).toEqual(["Which environment do you want to use?"]);
  });

  test("supports process environment without a file", async () => {
    const directory = createEnvironmentDirectory([]);
    const interaction = new SelectionInteraction("Use process environment only");

    await expect(selectEnvironmentFile(interaction, directory)).resolves.toBeUndefined();
  });

  test("supports an entered path", async () => {
    const directory = createEnvironmentDirectory([]);
    const customPath = "../shared/config.env";
    const interaction = new SelectionInteraction("Enter another path", customPath);

    await expect(selectEnvironmentFile(interaction, directory)).resolves.toBe(customPath);
    expect(interaction.labels).toEqual([
      "Which environment do you want to use?",
      "Environment file path",
    ]);
  });

  test("supports exiting before configuration is loaded", async () => {
    const directory = createEnvironmentDirectory([]);
    const interaction = new SelectionInteraction("Exit");

    await expect(selectEnvironmentFile(interaction, directory)).rejects.toBeInstanceOf(
      CancelledError,
    );
  });
});

function createEnvironmentDirectory(fileNames: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "playground-environments-"));
  for (const fileName of fileNames) writeFileSync(join(directory, fileName), "");
  return directory;
}
