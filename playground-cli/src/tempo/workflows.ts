import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi, toHex, zeroAddress, type Address, type PrivateKeyAccount } from "viem";
import type { Environment } from "../config.ts";
import { PlaygroundError, UsageError } from "../errors.ts";
import type { Interaction } from "../interaction.ts";
import type { Output } from "../output.ts";
import {
  broadcastSchema, preparedSchema, readArtifact, requireNewFile, serializePrepared, signedSchema,
  sponsorTempoTransaction, transferBalanceOwners, transferSummary, validatePrepared, validateSignature, validateSigned, writeArtifact,
  type BroadcastRecord, type PreparedTransaction,
} from "./artifacts.ts";
import {
  currencySchema, feeManagerAddress, formatSchema, getTempoConfiguration, getTempoSponsorAccount, hashSchema,
  integerSchema, moderatoFeeTokens, parseAddress, parseAmount, requireModerato, tempoNetworks,
  type TempoConfiguration, type TempoCurrency,
} from "./config.ts";
import { observeReceipt } from "./observe.ts";
import { displayBalances, TempoRpc, tokenAbi, type TempoFetch, type TokenMetadata } from "./rpc.ts";
import { getTempoSigningConfiguration, signTempoTransaction, turnkeyTypeSchema, type StampRequest } from "./turnkey.ts";

export type TempoRuntime = { environment: Environment; interaction: Interaction; output: Output };
export type TempoDependencies = { fetcher?: TempoFetch; stamp?: StampRequest };
export type TempoOptions = {
  network?: string;
  currency?: string;
  tokenAddress?: string;
  address?: string;
  from?: string;
  to?: string;
  amount?: string;
  format?: string;
  feeToken?: string;
  sponsored?: boolean;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  out?: string;
  file?: string;
  record?: string;
  hash?: string;
  turnkeyType?: string;
  activityId?: string;
};

type FeePayer = PreparedTransaction["fee_payer"];
type GasLimit = { amount: bigint; source: string };

async function connect(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies, writes = false) {
  let network = options.network;
  if (!network && runtime.interaction.interactive) {
    network = await runtime.interaction.choose("Tempo network", [
      { name: "Moderato testnet (42431)", value: "moderato" },
      { name: "Mainnet (4217), inspection only", value: "mainnet" },
    ]);
  }
  const configuration = getTempoConfiguration(runtime.environment, network);
  if (writes) requireModerato(configuration);
  const rpc = new TempoRpc(configuration, runtime.output, dependencies.fetcher);
  await rpc.assertChain();
  return rpc;
}

async function selectCurrency(runtime: TempoRuntime, currency?: string): Promise<TempoCurrency> {
  const value = currency ?? await runtime.interaction.choose("Currency mapping", [
    { name: "USDC (AlphaUSD on Moderato; USDC.e on mainnet)", value: "USDC" },
    { name: "USDT (BetaUSD on Moderato; USDT0 on mainnet)", value: "USDT" },
  ]);
  const parsed = currencySchema.safeParse(value);
  if (!parsed.success) throw new UsageError("Currency must be USDC or USDT");
  return parsed.data;
}

async function transferAsset(rpc: TempoRpc, currency: TempoCurrency, tokenAddress?: string): Promise<TokenMetadata> {
  const configured = tempoNetworks[rpc.configuration.network].tokens[currency];
  const metadata = await rpc.metadata(parseAddress(tokenAddress ?? configured.address, "Token contract"));
  if (!tokenAddress && metadata.token_symbol !== configured.symbol) throw new PlaygroundError("The configured token contract returned an unexpected symbol");
  if (metadata.decimals !== 6 || metadata.currency !== "USD") throw new PlaygroundError("The selected token must be a six-decimal USD TIP-20 token");
  return metadata;
}

function networkSummary(configuration: TempoConfiguration) {
  return { network: configuration.network, chain_id: configuration.chainId, rpc_chain_verified: true, test_fixture: configuration.network === "moderato" };
}

export async function inspectTempo(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies = {}) {
  const rpc = await connect(runtime, options, dependencies);
  if (options.tokenAddress && !options.currency) throw new UsageError("A token override requires --currency USDC or USDT");
  const currencies = options.currency ? [await selectCurrency(runtime, options.currency)] : ["USDC", "USDT"] as const;
  const block = await rpc.block();
  const tokens = await Promise.all(currencies.map(async (currency) => {
    const metadata = await transferAsset(rpc, currency, options.tokenAddress);
    return { currency_mapping: currency, ...metadata, explorer_url: `${rpc.configuration.explorerUrl}/address/${metadata.token_address}` };
  }));
  runtime.output.result({ ...networkSummary(rpc.configuration), block_number: block.number.toString(), tokens });
}

export async function readTempoBalances(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies = {}) {
  const owner = parseAddress(await runtime.interaction.text("Wallet address", options.address), "Wallet address");
  const rpc = await connect(runtime, options, dependencies);
  if (options.tokenAddress && !options.currency) throw new UsageError("A token override requires --currency USDC or USDT");
  const currencies = options.currency ? [await selectCurrency(runtime, options.currency)] : ["USDC", "USDT"] as const;
  const tokens = await Promise.all(currencies.map((currency) => transferAsset(rpc, currency, options.tokenAddress)));
  const snapshot = await rpc.snapshot([owner], tokens.map((asset) => asset.token_address));
  runtime.output.result({ ...networkSummary(rpc.configuration), tokens, ...displayBalances(snapshot, tokens) });
}

function integerOption(value: string | undefined, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!integerSchema.safeParse(value).success) throw new UsageError(`${label} must be an unsigned decimal integer`);
  return BigInt(value);
}

async function selectFeePayer(runtime: TempoRuntime, options: TempoOptions, format: string): Promise<FeePayer> {
  if (options.sponsored) {
    if (format !== "tempo") throw new UsageError("Sponsorship requires the native Tempo format");
    return "sponsor";
  }
  if (format !== "tempo" || !runtime.interaction.interactive) return "sender";
  return runtime.interaction.choose<FeePayer>("Who pays the network fee?", [
    { name: "Sender", value: "sender" },
    { name: "Sponsor (TEMPO_SPONSOR_PRIVATE_KEY)", value: "sponsor" },
  ]);
}

async function resolveFeeAsset(
  runtime: TempoRuntime,
  rpc: TempoRpc,
  options: TempoOptions,
  asset: TokenMetadata,
  feePayer: FeePayer,
): Promise<TokenMetadata> {
  if (feePayer === "sponsor") {
    const token = tempoNetworks.moderato.tokens.USDC.address;
    if (asset.token_address.toLowerCase() !== token) throw new UsageError("Sponsored transfers require Moderato USDC (AlphaUSD)");
    if (options.feeToken && parseAddress(options.feeToken, "Fee token").toLowerCase() !== token) {
      throw new UsageError("Sponsored transfers must pay fees in AlphaUSD");
    }
    return asset;
  }
  const address = await runtime.interaction.text("Fee token contract address (sender pays)", options.feeToken);
  return rpc.metadata(parseAddress(address, "Fee token"));
}

async function prepareGasLimit(rpc: TempoRpc, options: TempoOptions, transaction: Record<string, unknown>, feePayer: FeePayer): Promise<GasLimit> {
  const explicit = integerOption(options.gasLimit, "Gas limit");
  if (explicit !== undefined) return { amount: explicit, source: "explicit input" };
  if (feePayer === "sponsor") return { amount: 1_000_000n, source: "sponsored transfer default" };
  const estimate = await rpc.quantity("eth_estimateGas", [transaction]);
  return { amount: (estimate * 120n + 99n) / 100n, source: "RPC estimate plus 20 percent" };
}

function resolvePreparedSponsor(runtime: TempoRuntime, prepared: PreparedTransaction): PrivateKeyAccount | undefined {
  if (prepared.fee_payer !== "sponsor") return undefined;
  const sponsor = getTempoSponsorAccount(runtime.environment);
  if (sponsor.address.toLowerCase() !== prepared.sponsor_address?.toLowerCase()) {
    throw new UsageError("TEMPO_SPONSOR_PRIVATE_KEY does not match the prepared sponsor address");
  }
  return sponsor;
}

export async function prepareTempoTransfer(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies = {}) {
  const source = parseAddress(await runtime.interaction.text("Disposable test source address", options.from), "Source address");
  const destination = parseAddress(await runtime.interaction.text("Test recipient address", options.to), "Destination address");
  if (source === zeroAddress || destination === zeroAddress || source === destination) throw new UsageError("Use distinct, nonzero source and recipient addresses");
  const currency = await selectCurrency(runtime, options.currency);
  const selectedFormat = options.format ?? await runtime.interaction.choose("Transaction format experiment", [
    { name: "Native Tempo (0x76)", value: "tempo" },
    { name: "EIP-1559 (0x02)", value: "eip1559" },
  ]);
  const format = formatSchema.safeParse(selectedFormat);
  if (!format.success) throw new UsageError("Transaction format must be tempo or eip1559");
  const feePayer = await selectFeePayer(runtime, options, format.data);
  let sponsor: PrivateKeyAccount | undefined;
  if (feePayer === "sponsor") {
    if (currency !== "USDC") throw new UsageError("Sponsored transfers require Moderato USDC (AlphaUSD)");
    sponsor = getTempoSponsorAccount(runtime.environment);
    if (sponsor.address.toLowerCase() === source.toLowerCase()) throw new UsageError("Use a sponsor different from the source wallet");
  }
  if (format.data === "eip1559" && options.feeToken) throw new UsageError("EIP-1559 cannot encode --fee-token; use the native Tempo format to select one explicitly");
  const amountInput = await runtime.interaction.text("Transfer amount", options.amount);
  const out = await runtime.interaction.text("Prepared transaction output file", options.out);
  requireNewFile(out);
  const rpc = await connect(runtime, options, dependencies, true);
  const asset = await transferAsset(rpc, currency, options.tokenAddress);
  const amount = parseAmount(amountInput, asset.decimals);
  let feeAsset: TokenMetadata | undefined;
  if (format.data === "tempo") feeAsset = await resolveFeeAsset(runtime, rpc, options, asset, feePayer);
  const nonce = await rpc.quantity("eth_getTransactionCount", [source, "pending"]);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new UsageError("The account nonce exceeds the supported range");
  const maxPriorityFee = integerOption(options.maxPriorityFeePerGas, "Max priority fee per gas") ?? await rpc.quantity("eth_maxPriorityFeePerGas", []);
  const maxFee = integerOption(options.maxFeePerGas, "Max fee per gas") ?? (await rpc.quantity("eth_gasPrice", [])) * 2n + maxPriorityFee;
  const data = encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [destination, amount] });
  let transaction: Record<string, unknown>;
  if (format.data === "tempo") {
    transaction = {
      type: "0x76", from: source, chainId: toHex(rpc.configuration.chainId), nonce: toHex(nonce),
      calls: [{ to: asset.token_address, data, value: "0x0" }], nonceKey: "0x0", feeToken: feeAsset!.token_address,
      keyType: "secp256k1",
    };
  } else {
    transaction = {
      type: "0x2", from: source, to: asset.token_address, data, value: "0x0", chainId: toHex(rpc.configuration.chainId), nonce: toHex(nonce),
    };
  }
  const gasLimit = await prepareGasLimit(rpc, options, transaction, feePayer);
  const fields: Omit<PreparedTransaction, "unsigned_transaction"> = {
    version: 1, kind: "tempo-prepared", network: "moderato", chain_id: 42431, created_at: new Date().toISOString(),
    format: format.data, source, destination, currency, transfer_asset: asset, amount_units: amount.toString(),
    fee_asset: feeAsset, fee_payer: feePayer, sponsor_address: sponsor?.address, nonce: Number(nonce), gas_limit: gasLimit.amount.toString(),
    max_fee_per_gas: maxFee.toString(), max_priority_fee_per_gas: maxPriorityFee.toString(),
  };
  const parsed = preparedSchema.safeParse({ ...fields, unsigned_transaction: await serializePrepared(fields) });
  if (!parsed.success) throw new UsageError("Transaction parameters exceed supported ranges");
  await validatePrepared(parsed.data);
  writeArtifact(out, parsed.data);
  runtime.output.result({ status: "prepared", file: resolve(out), ...transferSummary(parsed.data), gas_limit_source: gasLimit.source });
}

async function validateCurrentAssets(rpc: TempoRpc, prepared: PreparedTransaction) {
  for (const expected of [prepared.transfer_asset, prepared.fee_asset].filter((asset) => asset !== undefined)) {
    const current = await rpc.metadata(expected.token_address);
    if (current.decimals !== expected.decimals || current.currency !== expected.currency || current.token_symbol !== expected.token_symbol) {
      throw new PlaygroundError("Token metadata changed since preparation; prepare a new transaction");
    }
  }
}

export async function signTempoTransfer(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies = {}) {
  const configuration = getTempoSigningConfiguration(runtime.environment);
  const file = await runtime.interaction.text("Prepared transaction file", options.file);
  const prepared = readArtifact(file, preparedSchema);
  await validatePrepared(prepared);
  const sponsor = resolvePreparedSponsor(runtime, prepared);
  const out = await runtime.interaction.text("Signed transaction output file", options.out);
  requireNewFile(out);
  const selectedType = options.turnkeyType ?? await runtime.interaction.choose("Turnkey transaction type experiment", [
    { name: "TRANSACTION_TYPE_TEMPO", value: "TRANSACTION_TYPE_TEMPO" },
    { name: "TRANSACTION_TYPE_ETHEREUM", value: "TRANSACTION_TYPE_ETHEREUM" },
  ]);
  const transactionType = turnkeyTypeSchema.safeParse(selectedType);
  if (!transactionType.success) throw new UsageError("Select TRANSACTION_TYPE_TEMPO or TRANSACTION_TYPE_ETHEREUM");
  if (sponsor && transactionType.data !== "TRANSACTION_TYPE_TEMPO") {
    throw new UsageError("Sponsored transfers require TRANSACTION_TYPE_TEMPO");
  }
  const rpc = await connect(runtime, options, dependencies, true);
  await validateCurrentAssets(rpc, prepared);
  runtime.output.info(JSON.stringify({ ...transferSummary(prepared), turnkey_type: transactionType.data }));
  if (!options.activityId) await runtime.interaction.approve("Ask Turnkey to sign this test transfer", false);
  const result = await signTempoTransaction({ prepared, transactionType: transactionType.data, configuration, output: runtime.output, activityId: options.activityId, ...dependencies });
  if (!result.signed_transaction) {
    runtime.output.result({ activity_id: result.activity_id, status: result.status, next_step: "Resume sign with --activity-id and the same prepared file; no transaction was broadcast" });
    if (["ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED"].includes(result.status)) throw new PlaygroundError("Turnkey did not sign the transaction");
    return;
  }
  let signedTransaction = result.signed_transaction;
  if (sponsor) signedTransaction = await sponsorTempoTransaction(prepared, signedTransaction, sponsor);
  const hash = await validateSignature(prepared, signedTransaction);
  writeArtifact(out, {
    version: 1, kind: "tempo-signed", prepared, turnkey_type: transactionType.data,
    activity_id: result.activity_id, signed_transaction: signedTransaction, transaction_hash: hash,
  });
  runtime.output.result({ status: "signed", file: resolve(out), activity_id: result.activity_id, transaction_hash: hash, ...transferSummary(prepared), turnkey_type: transactionType.data });
}

async function balanceTokens(rpc: TempoRpc, prepared: PreparedTransaction): Promise<Address[]> {
  if (prepared.fee_payer === "sponsor") return [prepared.transfer_asset.token_address];
  const abi = parseAbi(["function userTokens(address) view returns (address)"]);
  const result = await rpc.request("eth_call", [{ to: feeManagerAddress, data: encodeFunctionData({ abi, functionName: "userTokens", args: [prepared.source] }) }, "latest"]);
  let preference: Address;
  try {
    preference = decodeFunctionResult({ abi, functionName: "userTokens", data: result as `0x${string}` });
  } catch {
    throw new PlaygroundError("Could not decode the source account fee-token preference");
  }
  return [
    ...moderatoFeeTokens,
    prepared.transfer_asset.token_address,
    ...(prepared.fee_asset ? [prepared.fee_asset.token_address] : []),
    ...(preference === zeroAddress ? [] : [preference]),
  ];
}

export async function broadcastTempoTransfer(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies = {}) {
  const file = await runtime.interaction.text("Signed transaction file", options.file);
  const signed = readArtifact(file, signedSchema);
  await validateSigned(signed);
  const recordPath = await runtime.interaction.text("Broadcast record file (reuse to observe an earlier attempt)", options.record);
  const rpc = await connect(runtime, options, dependencies, true);
  if (existsSync(resolve(recordPath))) {
    const record = readArtifact(recordPath, broadcastSchema);
    reportReceipt(runtime, await observeReceipt(rpc, signed.transaction_hash, record));
    return;
  }
  if (await rpc.receipt(signed.transaction_hash)) {
    reportReceipt(runtime, await observeReceipt(rpc, signed.transaction_hash));
    return;
  }
  await validateCurrentAssets(rpc, signed.prepared);
  const nonce = await rpc.quantity("eth_getTransactionCount", [signed.prepared.source, "pending"]);
  if (nonce !== BigInt(signed.prepared.nonce)) throw new PlaygroundError("The source nonce changed; inspect the recorded transaction hash before preparing another transfer");
  runtime.output.info(JSON.stringify(transferSummary(signed.prepared)));
  await runtime.interaction.approve("Broadcast this transfer from the disposable Moderato wallet", false);
  const tokens = await balanceTokens(rpc, signed.prepared);
  const before = await rpc.snapshot(transferBalanceOwners(signed.prepared), tokens);
  const record: BroadcastRecord = {
    version: 1, kind: "tempo-broadcast", prepared: signed.prepared, transaction_hash: signed.transaction_hash,
    attempt_recorded_at: new Date().toISOString(), before,
  };
  writeArtifact(recordPath, record);
  let result: unknown;
  try {
    result = await rpc.request("eth_sendRawTransaction", [signed.signed_transaction]);
  } catch (error) {
    runtime.output.result({ status: "submission_unconfirmed", record: resolve(recordPath), transaction_hash: signed.transaction_hash, next_step: "Use receipt --record with this file; no automatic resubmission" });
    throw error;
  }
  if (!hashSchema.safeParse(result).success || String(result).toLowerCase() !== signed.transaction_hash.toLowerCase()) {
    runtime.output.result({ status: "submission_unconfirmed", record: resolve(recordPath), transaction_hash: signed.transaction_hash });
    throw new PlaygroundError("RPC returned a different transaction hash; inspect the saved hash without resubmitting");
  }
  runtime.output.result({ status: "submitted", record: resolve(recordPath), transaction_hash: signed.transaction_hash, explorer_url: `${rpc.configuration.explorerUrl}/tx/${signed.transaction_hash}`, ...transferSummary(signed.prepared), before });
}

export async function readTempoReceipt(runtime: TempoRuntime, options: TempoOptions, dependencies: TempoDependencies = {}) {
  const record = options.record ? readArtifact(options.record, broadcastSchema) : undefined;
  const selectedHash = options.hash ?? record?.transaction_hash ?? await runtime.interaction.text("Transaction hash");
  const hash = hashSchema.safeParse(selectedHash);
  if (!hash.success) throw new UsageError("Transaction hash must be a 32-byte hexadecimal value");
  const rpc = await connect(runtime, options, dependencies);
  const report = await observeReceipt(rpc, hash.data, record);
  reportReceipt(runtime, report);
}

function reportReceipt(runtime: TempoRuntime, report: Awaited<ReturnType<typeof observeReceipt>>) {
  runtime.output.result(report);
  if (report.status === "reverted") throw new PlaygroundError("Tempo transaction reverted");
  if ("sponsorship_verified" in report && report.sponsorship_verified === false) throw new PlaygroundError("The receipt does not prove the intended sponsor and fee");
  if ("intended_transfer_verified" in report && report.intended_transfer_verified === false) throw new PlaygroundError("The receipt does not prove the intended transfer");
}
