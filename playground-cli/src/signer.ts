import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import type { SigningConfiguration } from "./config.ts";
import { UsageError } from "./errors.ts";

const networkTypes: Readonly<Record<string, string>> = {
  BASE: "TRANSACTION_TYPE_ETHEREUM",
  BASE_SEPOLIA: "TRANSACTION_TYPE_ETHEREUM",
  ETHEREUM: "TRANSACTION_TYPE_ETHEREUM",
  ETHEREUM_SEPOLIA: "TRANSACTION_TYPE_ETHEREUM",
  POLYGON: "TRANSACTION_TYPE_ETHEREUM",
  POLYGON_AMOY: "TRANSACTION_TYPE_ETHEREUM",
  SOLANA: "TRANSACTION_TYPE_SOLANA",
};

export type SignStepInput = {
  unsignedTransaction: string;
  signWith: string;
  network: string;
};

export async function signStep(
  configuration: SigningConfiguration,
  input: SignStepInput,
): Promise<string> {
  const transactionType = networkTypes[input.network];
  if (!transactionType) {
    throw new UsageError(
      `Unsupported signing network ${input.network}. Supported: ${Object.keys(networkTypes).join(", ")}`,
    );
  }
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    timestampMs: String(Date.now()),
    organizationId: configuration.enclaveId,
    parameters: {
      signWith: input.signWith,
      unsignedTransaction: input.unsignedTransaction,
      type: transactionType,
    },
  });
  const stamped = await new ApiKeyStamper({
    apiPublicKey: configuration.publicKey,
    apiPrivateKey: configuration.privateKey,
  }).stamp(body);
  return Buffer.from(
    JSON.stringify({ body, stamp: stamped.stampHeaderValue }),
    "utf8",
  ).toString("base64");
}
