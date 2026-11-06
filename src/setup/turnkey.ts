import { ApiKeyStamper } from "@turnkey/api-key-stamper";

export interface TurnkeyCredentials {
  apiPublicKey: string;
  apiPrivateKey: string;
  /** The workspace's Turnkey sub-organization; not in any Tesser API response. */
  organizationId: string;
}

/** Turnkey credentials from the env, or `undefined` when none are set. */
export function turnkeyCredentials(): TurnkeyCredentials | undefined {
  const apiPublicKey = process.env.TURNKEY_API_PUBLIC_KEY;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  if (!apiPublicKey && !apiPrivateKey && !organizationId) return undefined;
  if (!apiPublicKey || !apiPrivateKey || !organizationId) {
    throw new Error("Set all of TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY and TURNKEY_ORGANIZATION_ID, or none");
  }
  return { apiPublicKey, apiPrivateKey, organizationId };
}

/**
 * The managed wallet `signature`: a stamped Turnkey CREATE_WALLET for one EVM
 * account, as base64 `{ body, stamp }`. It authorizes the creation; never print it.
 */
export async function signCreateEvmWallet(walletName: string, credentials: TurnkeyCredentials): Promise<string> {
  const body = JSON.stringify({
    type: "ACTIVITY_TYPE_CREATE_WALLET",
    timestampMs: Date.now().toString(),
    organizationId: credentials.organizationId,
    parameters: {
      walletName,
      accounts: [
        {
          curve: "CURVE_SECP256K1",
          pathFormat: "PATH_FORMAT_BIP32",
          path: "m/44'/60'/0'/0/0",
          addressFormat: "ADDRESS_FORMAT_ETHEREUM",
        },
      ],
    },
  });
  const stamper = new ApiKeyStamper({
    apiPublicKey: credentials.apiPublicKey,
    apiPrivateKey: credentials.apiPrivateKey,
  });
  const { stampHeaderValue } = await stamper.stamp(body);
  return btoa(JSON.stringify({ body, stamp: stampHeaderValue }));
}
