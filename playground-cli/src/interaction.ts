import { confirm as confirmPrompt, input, password, select } from "@inquirer/prompts";
import { CancelledError, UsageError } from "./errors.ts";

export type Choice<T> = { name: string; value: T; description?: string };

export interface Interaction {
  readonly interactive: boolean;
  text(label: string, value?: string, defaultValue?: string): Promise<string>;
  optionalText(label: string, defaultValue?: string): Promise<string | undefined>;
  secret(label: string, value?: string): Promise<string>;
  choose<T>(label: string, choices: Choice<T>[]): Promise<T>;
  confirm(label: string, defaultValue?: boolean): Promise<boolean>;
  approve(label: string, defaultValue?: boolean): Promise<void>;
}

export class TerminalInteraction implements Interaction {
  readonly interactive = true;

  async text(label: string, value?: string, defaultValue?: string): Promise<string> {
    if (value?.trim()) return value.trim();
    const answer = await input({ message: label, default: defaultValue });
    if (!answer.trim()) throw new UsageError(`${label} is required`);
    return answer.trim();
  }

  async optionalText(label: string, defaultValue?: string): Promise<string | undefined> {
    const answer = await input({ message: label, default: defaultValue });
    return answer.trim() || undefined;
  }

  async secret(label: string, value?: string): Promise<string> {
    if (value?.trim()) return value.trim();
    const answer = await password({ message: label, mask: "*" });
    if (!answer.trim()) throw new UsageError(`${label} is required`);
    return answer.trim();
  }

  async choose<T>(label: string, choices: Choice<T>[]): Promise<T> {
    if (!choices.length) throw new UsageError(`No choices are available for ${label}`);
    return select({ message: label, choices });
  }

  async confirm(label: string, defaultValue = false): Promise<boolean> {
    return confirmPrompt({ message: label, default: defaultValue });
  }

  async approve(label: string, defaultValue = true): Promise<void> {
    const approved = await confirmPrompt({ message: label, default: defaultValue });
    if (!approved) throw new CancelledError(`Cancelled before ${label}`);
  }
}

export class NonInteractiveInteraction implements Interaction {
  readonly interactive = false;

  async text(label: string, value?: string, defaultValue?: string): Promise<string> {
    const resolved = value?.trim() || defaultValue?.trim();
    if (!resolved) throw new UsageError(`${label} must be provided in non-interactive mode`);
    return resolved;
  }

  async optionalText(_label: string, defaultValue?: string): Promise<string | undefined> {
    return defaultValue?.trim() || undefined;
  }

  async secret(label: string, value?: string): Promise<string> {
    if (!value?.trim()) throw new UsageError(`${label} must be provided in non-interactive mode`);
    return value.trim();
  }

  async choose<T>(label: string, choices: Choice<T>[]): Promise<T> {
    if (choices.length === 1) return choices[0]!.value;
    throw new UsageError(`${label} is ambiguous in non-interactive mode`);
  }

  async confirm(_label: string, defaultValue = false): Promise<boolean> {
    return defaultValue;
  }

  async approve(): Promise<void> {}
}
