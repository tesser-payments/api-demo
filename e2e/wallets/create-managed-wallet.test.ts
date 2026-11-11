import { describe, expect, test } from "bun:test";
import { getAvailableBalance } from "../../src/api/accounts.ts";
import { runWallet, RUN_WALLET_NAME, usdcOf } from "../fixtures/managed-wallet.ts";

// Above the sum of the waits inside, so their timeout hints surface first.
const CREATE_TIMEOUT_MS = 2 * 60_000;

describe("Create an Account: Managed Wallet", () => {
  test(
    "a managed wallet is created with the Kotlin SDK",
    async () => {
      const wallet = await runWallet();

      expect(wallet.name).toBe(RUN_WALLET_NAME);
      expect(wallet.type).toBe("stablecoin_ethereum");
      expect(wallet.is_managed).toBe(true);
      expect(wallet.crypto_wallet_address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(parseFloat(await getAvailableBalance(usdcOf(wallet.id)))).toBe(0);
    },
    CREATE_TIMEOUT_MS,
  );
});
