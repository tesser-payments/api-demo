import { getAddress, isAddress, parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { firstValue, requireEnvironmentVariables, type Environment } from "../config.ts";
import { UsageError } from "../errors.ts";

export const tempoNetworks = {
  mainnet: {
    chainId: 4217,
    rpcUrl: "https://rpc.tempo.xyz",
    explorerUrl: "https://explore.tempo.xyz",
    tokens: {
      USDC: { address: "0x20C000000000000000000000b9537d11c60E8b50", symbol: "USDC.e" },
      USDT: { address: "0x20C00000000000000000000014f22CA97301EB73", symbol: "USDT0" },
    },
  },
  moderato: {
    chainId: 42431,
    rpcUrl: "https://rpc.moderato.tempo.xyz",
    explorerUrl: "https://explore.testnet.tempo.xyz",
    tokens: {
      USDC: { address: "0x20c0000000000000000000000000000000000001", symbol: "AlphaUSD" },
      USDT: { address: "0x20c0000000000000000000000000000000000002", symbol: "BetaUSD" },
    },
  },
} as const;

export const moderatoFeeTokens = [
  "0x20c0000000000000000000000000000000000000",
  tempoNetworks.moderato.tokens.USDC.address,
  tempoNetworks.moderato.tokens.USDT.address,
  "0x20c0000000000000000000000000000000000003",
] as const;

export const feeManagerAddress = "0xfeec000000000000000000000000000000000000";
export const networkSchema = z.enum(["mainnet", "moderato"]);
export const addressSchema = z.string().refine((value) => isAddress(value, { strict: false }))
  .transform((value) => getAddress(value));
export const hexSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).transform((value) => value as `0x${string}`);
export const hashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value as `0x${string}`);
export const quantitySchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
export const integerSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const currencySchema = z.enum(["USDC", "USDT"]);
export const formatSchema = z.enum(["tempo", "eip1559"]);
export type TempoNetwork = z.infer<typeof networkSchema>;
export type TempoCurrency = z.infer<typeof currencySchema>;

export type TempoConfiguration = {
  network: TempoNetwork;
  chainId: number;
  rpcUrl: string;
  explorerUrl: string;
};

export function getTempoSponsorAccount(environment: Environment): PrivateKeyAccount {
  requireEnvironmentVariables(environment, "Tempo sponsorship", ["TEMPO_SPONSOR_PRIVATE_KEY"]);
  const privateKey = firstValue(environment, "TEMPO_SPONSOR_PRIVATE_KEY");
  try {
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error();
    return privateKeyToAccount(privateKey as `0x${string}`);
  } catch {
    throw new UsageError("TEMPO_SPONSOR_PRIVATE_KEY must contain a valid 0x-prefixed 32-byte private key");
  }
}

export function getTempoConfiguration(environment: Environment, network?: string): TempoConfiguration {
  const selected = networkSchema.safeParse(network);
  if (!selected.success) throw new UsageError("Select --network mainnet or moderato");
  const defaults = tempoNetworks[selected.data];
  const rpcUrl = firstValue(environment, selected.data === "mainnet" ? "TEMPO_MAINNET_RPC_URL" : "TEMPO_MODERATO_RPC_URL") ?? defaults.rpcUrl;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new UsageError("The selected Tempo RPC URL is invalid");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new UsageError("Tempo RPC requires an HTTP or HTTPS URL");
  return { network: selected.data, chainId: defaults.chainId, rpcUrl, explorerUrl: defaults.explorerUrl };
}

export function requireModerato(configuration: TempoConfiguration): void {
  if (configuration.network !== "moderato") {
    throw new UsageError("Direct transaction experiments require Moderato and disposable test wallets");
  }
}

export function parseAddress(value: string, label: string): Address {
  const parsed = addressSchema.safeParse(value);
  if (!parsed.success) throw new UsageError(`${label} must be an EVM address`);
  return parsed.data;
}

export function parseAmount(value: string, decimals: number): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value) || (value.split(".")[1]?.length ?? 0) > decimals) {
    throw new UsageError(`Amount must be a positive decimal with at most ${decimals} decimal places`);
  }
  const amount = parseUnits(value, decimals);
  if (amount <= 0n || amount >= 2n ** 256n) throw new UsageError("Amount must fit a positive uint256");
  return amount;
}
