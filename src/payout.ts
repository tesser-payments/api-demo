// Defaults known to work on sandbox: the Stellar address has a USDC trustline,
// and the EVM address is the documented sandbox risk-test address that is
// always automatically approved.
const DEFAULT_BENEFICIARY_ADDRESS = {
  stablecoin_stellar: "GCE5TKW3KAJJB3DPKXFWRIAKJEVOW6BDFGO6R4NRWS2JSZWRYNB2NKQG",
  stablecoin_ethereum: "0xd3f72b3e91c8124dfc1b4273e93594bb00c9be6f",
};

const ADDRESS_FORMAT = {
  stablecoin_stellar: /^G[A-Z2-7]{55}$/,
  stablecoin_ethereum: /^0x[0-9a-fA-F]{40}$/,
};

export type WalletType = keyof typeof DEFAULT_BENEFICIARY_ADDRESS;

export interface Payout {
  network: string;
  walletType: WalletType;
  address: string;
}

/**
 * The payout network and beneficiary address from `PAYMENT_NETWORK` and
 * `BENEFICIARY_WALLET_ADDRESS`. Throws before any API call if they don't match.
 */
export function payoutConfig(): Payout {
  const network = (process.env.PAYMENT_NETWORK || "STELLAR").toUpperCase();
  if (network.startsWith("SOLANA")) {
    throw new Error(`PAYMENT_NETWORK=${network} isn't supported here; use STELLAR or an EVM network`);
  }
  const walletType: WalletType = network.startsWith("STELLAR") ? "stablecoin_stellar" : "stablecoin_ethereum";
  const address = process.env.BENEFICIARY_WALLET_ADDRESS || DEFAULT_BENEFICIARY_ADDRESS[walletType];
  if (!ADDRESS_FORMAT[walletType].test(address)) {
    const family = walletType === "stablecoin_stellar" ? "a Stellar" : "an EVM";
    throw new Error(`BENEFICIARY_WALLET_ADDRESS isn't ${family} address, but PAYMENT_NETWORK=${network}`);
  }
  return { network, walletType, address };
}
