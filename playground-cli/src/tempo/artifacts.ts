import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeFunctionData, keccak256, parseTransaction, recoverAddress, serializeTransaction, toHex, type Hex } from "viem";
import { Transaction } from "viem/tempo";
import { z } from "zod";
import { UsageError } from "../errors.ts";
import { addressSchema, currencySchema, formatSchema, hashSchema, hexSchema, integerSchema } from "./config.ts";
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
  fee_payer: z.literal("sender"),
  nonce: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  gas_limit: integerSchema.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 64n),
  max_fee_per_gas: integerSchema.refine((value) => BigInt(value) > 0n && BigInt(value) < 2n ** 128n),
  max_priority_fee_per_gas: integerSchema.refine((value) => BigInt(value) < 2n ** 128n),
  unsigned_transaction: hexSchema,
});
export type PreparedTransaction = z.infer<typeof preparedSchema>;
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

export async function serializePrepared(prepared: Omit<PreparedTransaction, "unsigned_transaction">): Promise<Hex> {
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
    });
  }
  return serializeTransaction({ ...fields, type: "eip1559", to: prepared.transfer_asset.token_address, data, value: 0n });
}

export async function validatePrepared(prepared: PreparedTransaction): Promise<void> {
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

export async function validateSignature(prepared: PreparedTransaction, signedTransaction: Hex): Promise<Hex> {
  await validatePrepared(prepared);
  try {
    let unsignedTransaction: Hex;
    let transactionForHash = signedTransaction;
    let signature: { r: Hex; s: Hex; yParity: number };
    if (prepared.format === "tempo") {
      if (!signedTransaction.startsWith("0x76")) throw new Error();
      const transaction = Transaction.deserialize(signedTransaction as `0x76${string}`);
      if (transaction.signature?.type !== "secp256k1" || transaction.feePayerSignature !== undefined) throw new Error();
      const canonicalTransaction = await Transaction.serialize(transaction);
      const rawRecoveryByte = toHex(transaction.signature.signature.yParity, { size: 1 }).slice(2);
      const transactionWithRawRecoveryByte = `${canonicalTransaction.slice(0, -2)}${rawRecoveryByte}`;
      if (
        signedTransaction.toLowerCase() !== canonicalTransaction.toLowerCase() &&
        signedTransaction.toLowerCase() !== transactionWithRawRecoveryByte.toLowerCase()
      ) throw new Error();
      transactionForHash = canonicalTransaction;
      const { signature: envelope, ...unsigned } = transaction;
      unsignedTransaction = await Transaction.serialize(unsigned);
      signature = {
        r: toHex(envelope.signature.r, { size: 32 }),
        s: toHex(envelope.signature.s, { size: 32 }),
        yParity: envelope.signature.yParity,
      };
    } else {
      if (!signedTransaction.startsWith("0x02")) throw new Error();
      const { r, s, yParity, v, ...unsigned } = parseTransaction(signedTransaction as `0x02${string}`);
      if (!r || !s || yParity === undefined) throw new Error();
      if (serializeTransaction({ ...unsigned, r, s, yParity, v }).toLowerCase() !== signedTransaction.toLowerCase()) throw new Error();
      signature = { r, s, yParity };
      unsignedTransaction = serializeTransaction(unsigned);
    }
    if (unsignedTransaction.toLowerCase() !== prepared.unsigned_transaction.toLowerCase()) throw new Error();
    const signer = await recoverAddress({ hash: keccak256(unsignedTransaction), signature });
    if (signer.toLowerCase() !== prepared.source.toLowerCase()) throw new Error();
    return keccak256(transactionForHash);
  } catch {
    throw new UsageError("Signed transaction does not match the prepared transfer, fees, format, or source address");
  }
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
    fee_asset: prepared.fee_asset,
    fee_selection: prepared.format === "tempo" ? "explicit transaction fee token" : "account preference and chain fallback; inspect the receipt",
    nonce: prepared.nonce,
    gas_limit: prepared.gas_limit,
    max_fee_per_gas: prepared.max_fee_per_gas,
    max_priority_fee_per_gas: prepared.max_priority_fee_per_gas,
  };
}
