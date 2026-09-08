import { decodeEventLog, type Address, type Hex } from "viem";
import { PlaygroundError } from "../errors.ts";
import { validatePrepared, type BroadcastRecord } from "./artifacts.ts";
import { feeManagerAddress } from "./config.ts";
import { tokenAbi, type BalanceSnapshot, type TempoReceipt, type TempoRpc } from "./rpc.ts";

export function tokenMovements(receipt: TempoReceipt) {
  return receipt.logs.flatMap((log) => {
    if (log.removed) return [];
    try {
      const decoded = decodeEventLog({ abi: tokenAbi, eventName: "Transfer", data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
      const { from, to, amount } = decoded.args;
      return [{
        token_address: log.address,
        from,
        to,
        amount_units: amount.toString(),
        log_index: BigInt(log.logIndex).toString(),
        touches_fee_manager: [from, to].some((address) => address.toLowerCase() === feeManagerAddress),
      }];
    } catch {
      return [];
    }
  });
}

function balanceChanges(before: BalanceSnapshot, after: BalanceSnapshot) {
  return after.balances.map((entry) => {
    const previous = before.balances.find((balance) =>
      balance.owner.toLowerCase() === entry.owner.toLowerCase() && balance.token_address.toLowerCase() === entry.token_address.toLowerCase());
    return {
      owner: entry.owner,
      token_address: entry.token_address,
      before_units: previous?.balance_units,
      after_units: entry.balance_units,
      change_units: previous ? (BigInt(entry.balance_units) - BigInt(previous.balance_units)).toString() : undefined,
    };
  });
}

export async function observeReceipt(rpc: TempoRpc, hash: Hex, record?: BroadcastRecord) {
  if (record) await validatePrepared(record.prepared);
  const identity = {
    network: rpc.configuration.network,
    chain_id: rpc.configuration.chainId,
    transaction_hash: hash,
    explorer_url: `${rpc.configuration.explorerUrl}/tx/${hash}`,
  };
  if (record && (record.prepared.chain_id !== rpc.configuration.chainId || record.transaction_hash.toLowerCase() !== hash.toLowerCase())) {
    throw new PlaygroundError("Receipt selection does not match the broadcast record");
  }
  const receipt = await rpc.receipt(hash);
  if (!receipt) return { ...identity, status: "not_mined_or_not_found", next_step: "Repeat receipt with this hash; do not prepare or broadcast another transfer to resume observation" };
  const blockNumber = BigInt(receipt.blockNumber);
  const canonicalBlock = await rpc.block(blockNumber);
  if (canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new PlaygroundError("Receipt block is no longer canonical; repeat the read");
  const latestBlock = await rpc.block();
  const movements = tokenMovements(receipt);
  const transferMatched = record ? movements.some((movement) =>
    !movement.touches_fee_manager &&
    movement.token_address.toLowerCase() === record.prepared.transfer_asset.token_address.toLowerCase() &&
    movement.from.toLowerCase() === record.prepared.source.toLowerCase() &&
    movement.to.toLowerCase() === record.prepared.destination.toLowerCase() &&
    movement.amount_units === record.prepared.amount_units) : undefined;
  const feeMovements = movements.filter((movement) => movement.touches_fee_manager);
  const tokens = [...new Set([
    ...movements.map((movement) => movement.token_address.toLowerCase() as Address),
    ...(record?.before.balances.map((balance) => balance.token_address) ?? []),
    ...(receipt.feeToken ? [receipt.feeToken] : []),
  ])];
  const owners = record ? [record.prepared.source, record.prepared.destination] : [
    receipt.from,
    ...movements.filter((movement) => !movement.touches_fee_manager && movement.from.toLowerCase() === receipt.from.toLowerCase()).map((movement) => movement.to),
  ];
  const metadata = await Promise.all(tokens.map(async (address) => {
    try {
      return await rpc.metadata(address, blockNumber);
    } catch {
      return { token_address: address, metadata_unavailable: true };
    }
  }));
  let balances: Record<string, unknown>;
  try {
    if (blockNumber === 0n && !record) throw new PlaygroundError("No previous block is available");
    const before = record?.before ?? await rpc.snapshot(owners, tokens, blockNumber - 1n);
    if (BigInt(before.block_number) > blockNumber) throw new PlaygroundError("The saved baseline is later than this receipt");
    const beforeBlock = await rpc.block(BigInt(before.block_number));
    if (beforeBlock.hash.toLowerCase() !== before.block_hash.toLowerCase()) throw new PlaygroundError("The saved balance baseline is no longer canonical");
    const after = await rpc.snapshot(owners, tokens, blockNumber);
    balances = {
      available: true,
      before_basis: record ? "saved immediately before the broadcast attempt" : "end of the previous block",
      scope: "Chain balance differences include other transactions between these blocks",
      before,
      after,
      changes: balanceChanges(before, after),
    };
  } catch (error) {
    balances = { available: false, reason: error instanceof PlaygroundError ? error.message : "Historical token balances are unavailable" };
  }
  return {
    ...identity,
    status: receipt.status === "0x1" ? "success" : "reverted",
    block_number: blockNumber.toString(),
    block_hash: receipt.blockHash,
    observed_confirmations: (latestBlock.number >= blockNumber ? latestBlock.number - blockNumber + 1n : 0n).toString(),
    intended_transfer_verified: record ? receipt.status === "0x1" && transferMatched : undefined,
    token_metadata: metadata,
    token_movements: movements,
    fee_evidence: {
      receipt_fee_token: receipt.feeToken,
      receipt_fee_payer: receipt.feePayer,
      gas_used: BigInt(receipt.gasUsed).toString(),
      effective_gas_price: BigInt(receipt.effectiveGasPrice).toString(),
      transfers_touching_fee_manager: feeMovements,
      transfer_evidence: feeMovements.length ? "present; inspect debits and refunds separately" : "not present; no zero-fee conclusion",
    },
    balances,
    logs: receipt.logs,
  };
}
