import { describe, expect, test } from "bun:test";
import { throwawayApiKey } from "../testing/api-key.ts";
import { signCreateEvmWallet } from "./turnkey.ts";

describe("signCreateEvmWallet", () => {
  test("stamps a CREATE_WALLET activity for one EVM account in the sub-organization", async () => {
    const keys = await throwawayApiKey();
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
