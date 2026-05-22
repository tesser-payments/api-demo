// Tiny state store that lets one tutorial pass IDs to the next without
// the customer having to copy env vars by hand. The file lives next to
// the tutorial scripts and is gitignored.
//
// Convention: tutorial 01 calls `clearState()` at the start of every run
// — it's the chain's entry point and the canonical "start over" trigger.
// Every later tutorial does `loadState()` and asserts the keys it needs
// are present, with a clear error pointing the customer at tutorial 01
// when they're not.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  ".state.json",
);

export interface TutorialState {
  counterpartyId?: string;
  ledgerAccountId?: string;
  // Add more keys as later tutorials produce new resources.
}

export function loadState(): TutorialState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8")) as TutorialState;
  } catch {
    return {};
  }
}

export function saveState(updates: Partial<TutorialState>): void {
  const current = loadState();
  const next = { ...current, ...updates };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2));
}

export function clearState(): void {
  writeFileSync(STATE_PATH, "{}");
}

export const STATE_FILE_PATH = STATE_PATH;
