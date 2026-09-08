import { decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, toHex, type Address } from "viem";
import { z } from "zod";
import { PlaygroundError } from "../errors.ts";
import type { Output } from "../output.ts";
import { addressSchema, hashSchema, integerSchema, quantitySchema, type TempoConfiguration } from "./config.ts";

export const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function currency() view returns (string)",
  "function paused() view returns (bool)",
  "function transferPolicyId() view returns (uint64)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 amount)",
]);

export const tokenMetadataSchema = z.object({
  token_address: addressSchema,
  token_name: z.string(),
  token_symbol: z.string(),
  decimals: z.number().int().min(0).max(255),
  currency: z.string(),
  paused: z.boolean(),
  transfer_policy_id: integerSchema,
});
export type TokenMetadata = z.infer<typeof tokenMetadataSchema>;

export const balanceSnapshotSchema = z.object({
  block_number: integerSchema,
  block_hash: hashSchema,
  balances: z.array(z.object({
    owner: addressSchema,
    token_address: addressSchema,
    balance_units: integerSchema,
  })),
});
export type BalanceSnapshot = z.infer<typeof balanceSnapshotSchema>;

const receiptSchema = z.object({
  transactionHash: hashSchema,
  blockHash: hashSchema,
  blockNumber: quantitySchema,
  status: z.enum(["0x0", "0x1"]),
  from: addressSchema,
  to: addressSchema.nullable(),
  gasUsed: quantitySchema,
  effectiveGasPrice: quantitySchema,
  feePayer: addressSchema.optional(),
  feeToken: addressSchema.optional(),
  logs: z.array(z.object({
    address: addressSchema,
    topics: z.array(hashSchema),
    data: z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/).transform((value) => value as `0x${string}`),
    logIndex: quantitySchema,
    removed: z.boolean().optional(),
  })),
});
export type TempoReceipt = z.infer<typeof receiptSchema>;

export type TempoFetch = (input: string, init: RequestInit) => Promise<Response>;

export class TempoRpc {
  private requestId = 0;

  constructor(
    readonly configuration: TempoConfiguration,
    private readonly output: Output,
    private readonly fetcher: TempoFetch = fetch,
  ) {}

  async request(method: string, params: unknown[]): Promise<unknown> {
    const id = ++this.requestId;
    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetcher(this.configuration.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new PlaygroundError(`Tempo RPC ${method} failed (HTTP ${response.status})`);
      payload = await response.json();
    } catch (error) {
      if (error instanceof PlaygroundError) throw error;
      throw new PlaygroundError(`Tempo RPC ${method} did not return a usable response`);
    }
    const envelope = z.object({
      jsonrpc: z.literal("2.0"),
      id: z.literal(id),
      result: z.unknown().optional(),
      error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
    }).safeParse(payload);
    if (!envelope.success) throw new PlaygroundError(`Tempo RPC ${method} returned an invalid response`);
    if (envelope.data.error) {
      const { code, message = "" } = envelope.data.error;
      const category = ["insufficient funds", "nonce too low", "execution reverted", "already known", "unsupported transaction type"]
        .find((value) => message.toLowerCase().includes(value));
      this.output.exchange("tempo-rpc", { network: this.configuration.network, method }, { code, category });
      throw new PlaygroundError(`Tempo RPC ${method} failed (code ${code}${category ? `: ${category}` : ""})`);
    }
    if (!("result" in envelope.data)) throw new PlaygroundError(`Tempo RPC ${method} returned no result`);
    this.output.exchange("tempo-rpc", { network: this.configuration.network, method }, { received: true });
    return envelope.data.result;
  }

  async quantity(method: string, params: unknown[]): Promise<bigint> {
    const parsed = quantitySchema.safeParse(await this.request(method, params));
    if (!parsed.success) throw new PlaygroundError(`Tempo RPC ${method} returned an invalid quantity`);
    return BigInt(parsed.data);
  }

  async assertChain(): Promise<void> {
    const chainId = await this.quantity("eth_chainId", []);
    if (chainId !== BigInt(this.configuration.chainId)) {
      throw new PlaygroundError(`Tempo RPC chain mismatch: selected ${this.configuration.chainId}, received ${chainId}`);
    }
  }

  async block(blockNumber?: bigint): Promise<{ number: bigint; hash: `0x${string}` }> {
    const value = await this.request("eth_getBlockByNumber", [blockNumber === undefined ? "latest" : toHex(blockNumber), false]);
    const parsed = z.object({ number: quantitySchema, hash: hashSchema }).safeParse(value);
    if (!parsed.success) throw new PlaygroundError("Tempo RPC returned an unavailable or invalid block");
    return { number: BigInt(parsed.data.number), hash: parsed.data.hash };
  }

  async metadata(address: Address, blockNumber?: bigint): Promise<TokenMetadata> {
    const names = ["name", "symbol", "decimals", "currency", "paused", "transferPolicyId"] as const;
    const values = await Promise.all(names.map(async (functionName) => {
      const result = await this.request("eth_call", [{ to: address, data: encodeFunctionData({ abi: tokenAbi, functionName }) }, blockNumber === undefined ? "latest" : toHex(blockNumber)]);
      try {
        return decodeFunctionResult({ abi: tokenAbi, functionName, data: result as `0x${string}` });
      } catch {
        throw new PlaygroundError(`Could not decode TIP-20 ${functionName} for ${address}`);
      }
    }));
    const parsed = tokenMetadataSchema.safeParse({
      token_address: address,
      token_name: values[0],
      token_symbol: values[1],
      decimals: values[2],
      currency: values[3],
      paused: values[4],
      transfer_policy_id: String(values[5]),
    });
    if (!parsed.success) throw new PlaygroundError(`Invalid TIP-20 metadata for ${address}`);
    return parsed.data;
  }

  async snapshot(owners: Address[], tokens: Address[], blockNumber?: bigint): Promise<BalanceSnapshot> {
    const block = await this.block(blockNumber);
    const uniqueOwners = [...new Set(owners.map((owner) => owner.toLowerCase() as Address))];
    const uniqueTokens = [...new Set(tokens.map((address) => address.toLowerCase() as Address))];
    const balances = await Promise.all(uniqueOwners.flatMap((owner) => uniqueTokens.map(async (tokenAddress) => {
      const data = encodeFunctionData({ abi: tokenAbi, functionName: "balanceOf", args: [owner] });
      const result = await this.request("eth_call", [{ to: tokenAddress, data }, toHex(block.number)]);
      try {
        const balance = decodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", data: result as `0x${string}` });
        return { owner, token_address: tokenAddress, balance_units: balance.toString() };
      } catch {
        throw new PlaygroundError(`Could not decode TIP-20 balance for ${tokenAddress}`);
      }
    })));
    const confirmedBlock = await this.block(block.number);
    if (confirmedBlock.hash !== block.hash) throw new PlaygroundError("Tempo block changed during balance inspection; repeat the read");
    return { block_number: block.number.toString(), block_hash: block.hash, balances };
  }

  async receipt(hash: `0x${string}`): Promise<TempoReceipt | null> {
    const result = await this.request("eth_getTransactionReceipt", [hash]);
    if (result === null) return null;
    const parsed = receiptSchema.safeParse(result);
    if (!parsed.success || parsed.data.transactionHash.toLowerCase() !== hash.toLowerCase()) {
      throw new PlaygroundError("Tempo RPC returned an invalid or mismatched receipt");
    }
    return parsed.data;
  }
}

export function displayBalances(snapshot: BalanceSnapshot, tokens: TokenMetadata[]) {
  return {
    ...snapshot,
    balances: snapshot.balances.map((entry) => {
      const metadata = tokens.find((asset) => asset.token_address.toLowerCase() === entry.token_address.toLowerCase());
      return {
        ...entry,
        token_symbol: metadata?.token_symbol,
        balance: metadata ? formatUnits(BigInt(entry.balance_units), metadata.decimals) : undefined,
      };
    }),
  };
}
