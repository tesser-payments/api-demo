import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CancelledError } from "./errors.ts";
import type { Choice, Interaction } from "./interaction.ts";

type EnvironmentSelection =
  | { type: "file"; path: string }
  | { type: "process" }
  | { type: "custom" }
  | { type: "exit" };

export async function selectEnvironmentFile(
  interaction: Interaction,
  currentDirectory = process.cwd(),
): Promise<string | undefined> {
  const fileChoices: Choice<EnvironmentSelection>[] = readdirSync(currentDirectory, {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile() && isSelectableEnvironmentFile(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right))
    .map((fileName) => ({
      name: fileName,
      value: { type: "file", path: resolve(currentDirectory, fileName) },
    }));
  const selection = await interaction.choose<EnvironmentSelection>(
    "Which environment do you want to use?",
    [
      ...fileChoices,
      { name: "Use process environment only", value: { type: "process" } },
      { name: "Enter another path", value: { type: "custom" } },
      { name: "Exit", value: { type: "exit" } },
    ],
  );

  if (selection.type === "file") return selection.path;
  if (selection.type === "process") return undefined;
  if (selection.type === "custom") {
    return interaction.text("Environment file path");
  }
  throw new CancelledError("Cancelled before selecting an environment");
}

function isSelectableEnvironmentFile(fileName: string): boolean {
  if (!fileName.endsWith(".env")) return false;
  if (fileName === ".env" || fileName === ".env.local") return false;
  return !fileName.endsWith(".example.env");
}
