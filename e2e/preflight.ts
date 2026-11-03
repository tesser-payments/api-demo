import { findCircleMasterLedger, findCircleWireBank, storeCircleKey } from "../src/setup/circle.ts";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the E2E tests`);
  return value;
}

/**
 * Connect Circle and check the setup that can't be done through the Tesser
 * API, so a broken environment fails here instead of as a timeout mid-flow.
 */
export async function prepareCircle(): Promise<void> {
  const apiKey = requireEnv("CIRCLE_API_KEY");
  await storeCircleKey(apiKey);
  await findCircleMasterLedger();
  await findCircleWireBank(apiKey);
}
