import { test } from "vitest";

export interface FlowVariant {
  /** Full doc URL from the example's `meta.docUrl`. */
  docUrl: string;
  /** Liquidity provider key, e.g. "CIRCLE_MINT". Undefined when N/A. */
  provider?: string;
  /** Currency code, e.g. "USDC". Undefined when N/A. */
  currency?: string;
  /** Network key, e.g. "POLYGON". Undefined when N/A. */
  network?: string;
}

// Module-level registry — populated at test-define time, read by the reporter
// in the same process (singleFork). Keyed by the test's display name.
const VARIANTS = new Map<string, FlowVariant>();

function buildName(variant: FlowVariant, description: string): string {
  const slug = variant.docUrl.split("/").filter(Boolean).pop() ?? variant.docUrl;
  const parts: string[] = [slug];
  if (variant.provider) parts.push(`provider=${variant.provider}`);
  if (variant.currency) parts.push(`currency=${variant.currency}`);
  if (variant.network) parts.push(`network=${variant.network}`);
  parts.push(description);
  return parts.join(" | ");
}

export function flowTest(
  variant: FlowVariant,
  description: string,
  fn: () => Promise<void> | void,
  timeoutMs?: number,
): void {
  const name = buildName(variant, description);
  VARIANTS.set(name, variant);
  if (timeoutMs !== undefined) {
    test(name, fn, timeoutMs);
  } else {
    test(name, fn);
  }
}

export function getFlowVariant(name: string): FlowVariant | undefined {
  return VARIANTS.get(name);
}

export function getDocSlug(docUrl: string): string {
  return docUrl.split("/").filter(Boolean).pop() ?? docUrl;
}
