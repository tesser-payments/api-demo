import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeFunctionData, keccak256, parseTransaction, recoverAddress, serializeTransaction, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { Transaction } from "viem/tempo";
import { z } from "zod";
import { UsageError } from "../errors.ts";
import { addressSchema, currencySchema, formatSchema, hashSchema, hexSchema, integerSchema, tempoNetworks } from "./config.ts";
import { balanceSnapshotSchema, tokenAbi, tokenMetadataSchema } from "./rpc.ts";

export const preparedSchema = z.object({
  version: z.literal(1),
  kind: z.literal("tempo-prepared"),
  network: z.literal("moderato"),
  chain_id: z.literal(42431),
  created_at: z.iso.datetime(),
  format: formatSchema,
  source: addressSchema,
  destination: addressSchema,
  currency: currencySchema,
  transfer_asset: tokenMetadataSchema,
  amount_units: integerSchema.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 256n),
  fee_asset: tokenMetadataSchema.optional(),
  fee_payer: z.enum(["sender", "sponsor"]),
  sponsor_address: addressSchema.optional(),
  nonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  gas_limit: integerSchema.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 64n),
  max_fee_per_gas: integerSchema.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 128n),
  max_priority_fee_per_gas: integerSchema.refine((value) => BigInt(value) < 2n ** 128n),
  unsigned_transaction: hexSchema,
});
export type PreparedTransaction = z.infer<typeof preparedSchema>;
type PreparedFields = Omit<PreparedTransaction, "unsigned_transaction">;
type TempoTransaction = Transaction.TransactionSerializableTempo;
type VerifiedTempoCustomer = { transaction: TempoTransaction; canonicalTransaction: Hex };
export const signedSchema = z.object({
  version: z.literal(1),
  kind: z.literal("tempo-signed"),
  prepared: preparedSchema,
  turnkey_type: z.enum(["TRANSACTION_TYPE_ETHEREUM", "TRANSACTION_TYPE_TEMPO"]),
  activity_id: z.uuid(),
  signed_transaction: hexSchema,
  transaction_hash: hashSchema,
});
export type SignedTransaction = z.infer<typeof signedSchema>;
export const broadcastSchema = z.object({
  version: z.literal(1),
  kind: z.literal("tempo-broadcast"),
  prepared: preparedSchema,
  transaction_hash: hashSchema,
  attempt_recorded_at: z.iso.datetime(),
  before: balanceSnapshotSchema,
});
export type BroadcastRecord = z.infer<typeof broadcastSchema>;

export function readArtifact<T>(path: string, schema: z.ZodType<T>): T {
  try {
    return schema.parse(JSON.parse(readFileSync(resolve(path), "utf8")));
  } catch {
    throw new UsageError(`Could not read a valid Tempo artifact from ${resolve(path)}`);
  }
}

export function requireNewFile(path: string): void {
  if (existsSync(resolve(path))) throw new UsageError(`Output file already exists: ${resolve(path)}`);
}

export function writeArtifact(path: string, value: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolve(path), "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
  } catch {
    throw new UsageError(`Could not create Tempo artifact ${resolve(path)}; use a new file in an existing directory`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export async function serializePrepared(prepared: PreparedFields): Promise<Hex> {
  const data = encodeFunctionData({
    abi: tokenAbi,
    functionName: "transfer",
    args: [prepared.destination, BigInt(prepared.amount_units)],
  });
  const fields = {
    chainId: prepared.chain_id,
    nonce: prepared.nonce,
    gas: BigInt(prepared.gas_limit),
    maxFeePerGas: BigInt(prepared.max_fee_per_gas),
    maxPriorityFeePerGas: BigInt(prepared.max_priority_fee_per_gas),
  };
  if (prepared.format === "tempo") {
    return Transaction.serialize({
      ...fields,
      type: "tempo",
      calls: [{ to: prepared.transfer_asset.token_address, data, value: 0n }],
      nonceKey: 0n,
      feeToken: prepared.fee_asset?.token_address,
      ...(prepared.fee_payer === "sponsor" ? { feePayer: true as const } : {}),
    });
  }
  return serializeTransaction({ ...fields, type: "eip1559", to: prepared.transfer_asset.token_address, data, value: 0n });
}

export async function validatePrepared(prepared: PreparedTransaction): Promise<void> {
  validateSponsorshipSettings(prepared);
  if (
    (prepared.format === "tempo") !== Boolean(prepared.fee_asset) ||
    prepared.transfer_asset.decimals !== 6 || prepared.transfer_asset.currency !== "USD" ||
    (prepared.fee_asset && (prepared.fee_asset.decimals !== 6 || prepared.fee_asset.currency !== "USD")) ||
    BigInt(prepared.max_priority_fee_per_gas) > BigInt(prepared.max_fee_per_gas)
  ) throw new UsageError("Prepared Tempo asset, format, or fee settings are inconsistent");
  try {
    const serialized = await serializePrepared(prepared);
    if (serialized.toLowerCase() !== prepared.unsigned_transaction.toLowerCase()) throw new Error();
  } catch {
    throw new UsageError("Prepared transaction bytes do not match the recorded transfer and fees");
  }
}

function validateSponsorshipSettings(prepared: PreparedTransaction): void {
  if (prepared.fee_payer === "sender") {
    if (prepared.sponsor_address) throw new UsageError("A sender-paid transfer cannot select a sponsor");
    return;
  }
  if (prepared.format !== "tempo") throw new UsageError("Sponsorship requires the native Tempo format");
  if (!prepared.sponsor_address) throw new UsageError("The prepared sponsor address is missing");
  if (prepared.sponsor_address.toLowerCase() === prepared.source.toLowerCase()) {
    throw new UsageError("Use a sponsor different from the source wallet");
  }
  const token = tempoNetworks.moderato.tokens.USDC.address;
  if (prepared.currency !== "USDC" || prepared.transfer_asset.token_address.toLowerCase() !== token) {
    throw new UsageError("Sponsored transfers require Moderato USDC (AlphaUSD)");
  }
  if (prepared.fee_asset?.token_address.toLowerCase() !== token) {
    throw new UsageError("Sponsored transfers must pay fees in AlphaUSD");
  }
}

async function verifiedTempoCustomer(prepared: PreparedTransaction, signedTransaction: Hex): Promise<VerifiedTempoCustomer> {
  if (!signedTransaction.startsWith("0x76")) throw new Error();
  const transaction = Transaction.deserialize(signedTransaction as `0x76${string}`);
  if (transaction.signature?.type !== "secp256k1") throw new Error();
  if (prepared.fee_payer === "sender" && transaction.feePayerSignature !== undefined) throw new Error();
  const canonicalTransaction = await Transaction.serialize(transaction);
  const rawRecoveryByte = toHex(transaction.signature.signature.yParity, { size: 1 }).slice(2);
  const transactionWithRawRecoveryByte = `${canonicalTransaction.slice(0, -2)}${rawRecoveryByte}`;
  if (
    signedTransaction.toLowerCase() !== canonicalTransaction.toLowerCase() &&
    signedTransaction.toLowerCase() !== transactionWithRawRecoveryByte.toLowerCase()
  ) throw new Error();
  const { signature, ...unsigned } = transaction;
  let unsignedTransaction: Hex;
  if (prepared.fee_payer === "sponsor") {
    unsignedTransaction = await Transaction.serialize({ ...unsigned, feePayerSignature: undefined, feePayer: true });
  } else {
    unsignedTransaction = await Transaction.serialize(unsigned);
  }
  if (unsignedTransaction.toLowerCase() !== prepared.unsigned_transaction.toLowerCase()) throw new Error();
  const signer = await recoverAddress({
    hash: keccak256(unsignedTransaction),
    signature: {
      r: toHex(signature.signature.r, { size: 32 }),
      s: toHex(signature.signature.s, { size: 32 }),
      yParity: signature.signature.yParity,
    },
  });
  if (signer.toLowerCase() !== prepared.source.toLowerCase()) throw new Error();
  return { transaction, canonicalTransaction };
}

async function verifyTempoSponsor(prepared: PreparedTransaction, transaction: TempoTransaction): Promise<void> {
  const { feePayerSignature, ...unsigned } = transaction;
  if (!feePayerSignature || !prepared.sponsor_address) throw new Error();
  if (typeof transaction.feeToken !== "string") throw new Error();
  if (transaction.feeToken.toLowerCase() !== prepared.fee_asset?.token_address.toLowerCase()) throw new Error();
  const hash = Transaction.z_TxEnvelopeTempo.getFeePayerSignPayload(
    { ...unsigned, type: "tempo", nonce: BigInt(transaction.nonce ?? 0) },
    { sender: prepared.source },
  );
  const sponsor = await recoverAddress({ hash, signature: feePayerSignature });
  if (sponsor.toLowerCase() !== prepared.sponsor_address.toLowerCase()) throw new Error();
}

export async function sponsorTempoTransaction(prepared: PreparedTransaction, signedTransaction: Hex, sponsor: LocalAccount): Promise<Hex> {
  await validatePrepared(prepared);
  if (prepared.fee_payer !== "sponsor" || prepared.sponsor_address?.toLowerCase() !== sponsor.address.toLowerCase()) {
    throw new UsageError("The configured sponsor does not match the prepared transfer");
  }
  try {
    const { transaction } = await verifiedTempoCustomer(prepared, signedTransaction);
    if (transaction.feePayerSignature !== null || transaction.feeToken !== undefined) throw new Error();
    const sponsoredTransaction = await Transaction.serialize({
      ...transaction,
      from: prepared.source,
      feeToken: prepared.fee_asset!.token_address,
      feePayer: sponsor,
    });
    await validateSignature(prepared, sponsoredTransaction);
    return sponsoredTransaction;
  } catch {
    throw new UsageError("Could not verify and sponsor the approved Tempo transfer; no transaction was broadcast");
  }
}

export async function validateSignature(prepared: PreparedTransaction, signedTransaction: Hex): Promise<Hex> {
  await validatePrepared(prepared);
  try {
    if (prepared.format === "tempo") {
      const { transaction, canonicalTransaction } = await verifiedTempoCustomer(prepared, signedTransaction);
      if (prepared.fee_payer === "sponsor") {
        await verifyTempoSponsor(prepared, transaction);
        if (canonicalTransaction.toLowerCase() !== signedTransaction.toLowerCase()) throw new Error();
      }
      return keccak256(canonicalTransaction);
    }
    if (!signedTransaction.startsWith("0x02")) throw new Error();
    const { r, s, yParity, v, ...unsigned } = parseTransaction(signedTransaction as `0x02${string}`);
    if (!r || !s || yParity === undefined) throw new Error();
    if (serializeTransaction({ ...unsigned, r, s, yParity, v }).toLowerCase() !== signedTransaction.toLowerCase()) throw new Error();
    const unsignedTransaction = serializeTransaction(unsigned);
    if (unsignedTransaction.toLowerCase() !== prepared.unsigned_transaction.toLowerCase()) throw new Error();
    const signer = await recoverAddress({ hash: keccak256(unsignedTransaction), signature: { r, s, yParity } });
    if (signer.toLowerCase() !== prepared.source.toLowerCase()) throw new Error();
    return keccak256(signedTransaction);
  } catch {
    throw new UsageError("Signed transaction does not match the prepared transfer, fees, format, or source address");
  }
}

export function transferBalanceOwners(prepared: PreparedTransaction): Address[] {
  const owners = [prepared.source, prepared.destination];
  if (prepared.sponsor_address) owners.push(prepared.sponsor_address);
  return owners;
}

export async function validateSigned(signed: SignedTransaction): Promise<void> {
  const hash = await validateSignature(signed.prepared, signed.signed_transaction);
  if (hash.toLowerCase() !== signed.transaction_hash.toLowerCase()) throw new UsageError("Signed transaction hash does not match its bytes");
}

export function transferSummary(prepared: PreparedTransaction) {
  return {
    network: prepared.network,
    chain_id: prepared.chain_id,
    format: prepared.format,
    source: prepared.source,
    destination: prepared.destination,
    currency: prepared.currency,
    test_fixture: true,
    transfer_asset: prepared.transfer_asset,
    amount_units: prepared.amount_units,
    fee_payer: prepared.fee_payer,
    sponsor_address: prepared.sponsor_address,
    fee_asset: prepared.fee_asset,
    fee_selection: prepared.format === "tempo" ? "explicit transaction fee token" : "account preference and chain fallback; inspect the receipt",
    nonce: prepared.nonce,
    gas_limit: prepared.gas_limit,
    max_fee_per_gas: prepared.max_fee_per_gas,
    max_priority_fee_per_gas: prepared.max_priority_fee_per_gas,
  };
}
