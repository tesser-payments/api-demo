import { describe, expect, test } from "bun:test";
import { signCreateEvmWallet } from "./turnkey.ts";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

// A throwaway P-256 key in Turnkey's API key format: hex private scalar and
// compressed hex public key.
async function apiKeyPair() {
  const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const x = Buffer.from(jwk.x!, "base64url");
  const y = Buffer.from(jwk.y!, "base64url");
  const prefix = (y[y.length - 1]! & 1) === 0 ? "02" : "03";
  return { apiPublicKey: prefix + hex(x), apiPrivateKey: hex(Buffer.from(jwk.d!, "base64url")) };
}

describe("signCreateEvmWallet", () => {
  test("stamps a CREATE_WALLET activity for one EVM account in the sub-organization", async () => {
    const keys = await apiKeyPair();
    const signature = await signCreateEvmWallet("E2E wallet", { ...keys, organizationId: "sub-org-1" });

    const envelope = JSON.parse(atob(signature)) as { body: string; stamp: string };
    const body = JSON.parse(envelope.body);
    expect(body.type).toBe("ACTIVITY_TYPE_CREATE_WALLET");
    expect(body.organizationId).toBe("sub-org-1");
    expect(body.parameters.walletName).toBe("E2E wallet");
    expect(body.parameters.accounts.map((a: { addressFormat: string }) => a.addressFormat)).toEqual([
      "ADDRESS_FORMAT_ETHEREUM",
    ]);

    const stamp = JSON.parse(Buffer.from(envelope.stamp, "base64url").toString());
    expect(stamp.publicKey).toBe(keys.apiPublicKey);
    expect(stamp.scheme).toBe("SIGNATURE_SCHEME_TK_API_P256");
  });
});
