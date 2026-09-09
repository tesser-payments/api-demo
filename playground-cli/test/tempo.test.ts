import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, fromRlp, keccak256,
  parseSignature, toHex, toRlp, zeroAddress, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";
import { NonInteractiveInteraction } from "../src/interaction.ts";
import { Output, sanitize } from "../src/output.ts";
import {
  preparedSchema, readArtifact, signedSchema, validatePrepared, validateSignature, writeArtifact,
  type PreparedTransaction,
} from "../src/tempo/artifacts.ts";
import { feeManagerAddress, getTempoConfiguration, moderatoFeeTokens, parseAmount, tempoNetworks } from "../src/tempo/config.ts";
import { tokenAbi, type TempoFetch } from "../src/tempo/rpc.ts";
import { runTempoMenu } from "../src/tempo/commands.ts";
import {
  broadcastTempoTransfer, inspectTempo, prepareTempoTransfer, readTempoReceipt, signTempoTransfer,
  type TempoOptions, type TempoRuntime,
} from "../src/tempo/workflows.ts";

const account = privateKeyToAccount(toHex(1n, { size: 32 }));
const destination = "0x2222222222222222222222222222222222222222";
const activityId = "11111111-1111-4111-8111-111111111111";
const organizationId = "22222222-2222-4222-8222-222222222222";
const alphaUsd = tempoNetworks.moderato.tokens.USDC.address;
const feeToken = moderatoFeeTokens[0];
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class RecordingOutput extends Output {
  results: Record<string, unknown>[] = [];
  messages: string[] = [];
  constructor() { super("json", true); }
  override result(value: unknown): void { this.results.push(value as Record<string, unknown>); }
  override info(message: string): void { this.messages.push(message); }
  override exchange(operation: string, request: Record<string, unknown>, response: Record<string, unknown>): void {
    this.messages.push(JSON.stringify(sanitize({ operation, request, response })));
  }
}

function runtime() {
  return {
    environment: {
      TEMPO_TURNKEY_PUBLIC_KEY: "test-api-public-key",
      TEMPO_TURNKEY_PRIVATE_KEY: "test-api-private-secret",
      TEMPO_TURNKEY_ORGANIZATION_ID: organizationId,
    },
    interaction: new NonInteractiveInteraction(),
    output: new RecordingOutput(),
  };
}

async function signedBytes(unsigned: Hex): Promise<Hex> {
  const signature = parseSignature(await account.sign({ hash: keccak256(unsigned) }));
  if (unsigned.startsWith("0x76")) return Transaction.serialize(Transaction.deserialize(unsigned as `0x76${string}`), signature);
  return Transaction.serialize(Transaction.deserialize(unsigned as `0x02${string}`), signature);
}

function transferLog(tokenAddress: Address, from: Address, to: Address, amount: bigint, index: number) {
  return {
    address: tokenAddress,
    topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from, to } }),
    data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    logIndex: toHex(index),
    removed: false,
  };
}

class Providers {
  calls: { method: string; params: unknown[] }[] = [];
  turnkeyCalls: { path: string; body: Record<string, any> }[] = [];
  chainId = 42431;
  blockNumber = 100;
  receipt: Record<string, unknown> | null = null;
  submissionTimeout = false;
  estimateError = false;
  activityStatus = "ACTIVITY_STATUS_COMPLETED";
  preparedForActivity: PreparedTransaction | undefined;
  signedOverride: Hex | undefined;
  transactionHashOverride: Hex | undefined;
  historicalBalancesUnavailable = false;

  fetcher: TempoFetch = async (url, init) => {
    const body = JSON.parse(String(init.body));
    if (url.startsWith("https://api.turnkey.com/")) {
      this.turnkeyCalls.push({ path: new URL(url).pathname, body });
      const unsigned = body.parameters?.unsignedTransaction ?? this.preparedForActivity?.unsigned_transaction;
      return Response.json({ activity: {
        id: activityId, organizationId, type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2", status: this.activityStatus,
        intent: { signTransactionIntentV2: body.parameters ?? {
          signWith: this.preparedForActivity?.source,
          unsignedTransaction: unsigned,
          type: this.preparedForActivity?.format === "tempo" ? "TRANSACTION_TYPE_TEMPO" : "TRANSACTION_TYPE_ETHEREUM",
        } },
        result: this.activityStatus === "ACTIVITY_STATUS_COMPLETED" ? { signTransactionResult: { signedTransaction: this.signedOverride ?? await signedBytes(unsigned) } } : undefined,
      } });
    }
    this.calls.push({ method: body.method, params: body.params });
    if (body.method === "eth_sendRawTransaction" && this.submissionTimeout) throw new Error(`timeout: ${url} ${body.params[0]}`);
    if (body.method === "eth_estimateGas" && this.estimateError) {
      return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: `insufficient funds at ${url}, private-secret` } });
    }
    const result = await this.result(body.method, body.params);
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  };

  async result(method: string, params: any[]): Promise<unknown> {
    if (method === "eth_chainId") return toHex(this.chainId);
    if (method === "eth_getBlockByNumber") {
      const number = params[0] === "latest" ? this.blockNumber : Number(BigInt(params[0]));
      return { number: toHex(number), hash: toHex(number, { size: 32 }) };
    }
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_maxPriorityFeePerGas") return "0x0";
    if (method === "eth_gasPrice") return "0x64";
    if (method === "eth_estimateGas") return "0x186a0";
    if (method === "eth_getTransactionReceipt") return this.receipt;
    if (method === "eth_sendRawTransaction") {
      const hash = this.transactionHashOverride ?? keccak256(params[0]);
      this.mine(hash);
      return hash;
    }
    if (method !== "eth_call") throw new Error(`Unexpected test RPC method ${method}`);
    const [{ to, data }, block] = params;
    if (to.toLowerCase() === feeManagerAddress) return encodeAbiParameters([{ type: "address" }], [zeroAddress]);
    const decoded = decodeFunctionData({ abi: tokenAbi, data });
    if (decoded.functionName === "balanceOf") {
      if (this.historicalBalancesUnavailable) throw new Error("Archive unavailable");
      const [owner] = decoded.args;
      const after = block !== "latest" && BigInt(block) >= 101n;
      const sourceBalance = 10_000_000n - (after && to.toLowerCase() === alphaUsd ? 1_000_000n : 0n) - (after && to.toLowerCase() === feeToken ? 100n : 0n);
      const amount = owner.toLowerCase() === account.address.toLowerCase() ? sourceBalance : (after && to.toLowerCase() === alphaUsd ? 1_000_000n : 0n);
      return encodeFunctionResult({ abi: tokenAbi, functionName: "balanceOf", result: amount });
    }
    const symbols: Record<string, string> = {
      [moderatoFeeTokens[0]]: "pathUSD", [moderatoFeeTokens[1]]: "AlphaUSD", [moderatoFeeTokens[2]]: "BetaUSD", [moderatoFeeTokens[3]]: "ThetaUSD",
    };
    const symbol = symbols[to.toLowerCase()] ?? "CUSTOM";
    if (decoded.functionName === "name") return encodeFunctionResult({ abi: tokenAbi, functionName: "name", result: symbol });
    if (decoded.functionName === "symbol") return encodeFunctionResult({ abi: tokenAbi, functionName: "symbol", result: symbol });
    if (decoded.functionName === "decimals") return encodeFunctionResult({ abi: tokenAbi, functionName: "decimals", result: 6 });
    if (decoded.functionName === "currency") return encodeFunctionResult({ abi: tokenAbi, functionName: "currency", result: "USD" });
    if (decoded.functionName === "paused") return encodeFunctionResult({ abi: tokenAbi, functionName: "paused", result: false });
    if (decoded.functionName === "transferPolicyId") return encodeFunctionResult({ abi: tokenAbi, functionName: "transferPolicyId", result: 1n });
    throw new Error("Unexpected test contract call");
  }

  mine(hash: Hex, status = "0x1", recipient: Address = destination) {
    this.blockNumber = 101;
    this.receipt = {
      transactionHash: hash, blockHash: toHex(101, { size: 32 }), blockNumber: "0x65", status,
      from: account.address, to: alphaUsd, gasUsed: "0x186a0", effectiveGasPrice: "0x64",
      feeToken, feePayer: account.address,
      logs: [
        transferLog(feeToken, account.address, feeManagerAddress, 150n, 0),
        ...(status === "0x1" ? [transferLog(alphaUsd, account.address, recipient, 1_000_000n, 1)] : []),
        transferLog(feeToken, feeManagerAddress, account.address, 50n, 2),
      ],
    };
  }
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tempo-cli-test-"));
  temporaryDirectories.push(directory);
  const providers = new Providers();
  return {
    directory, providers, runtime: runtime(),
    dependencies: { fetcher: providers.fetcher, stamp: async () => "test-stamp-secret" },
    preparedFile: join(directory, "prepared.json"), signedFile: join(directory, "signed.json"), recordFile: join(directory, "broadcast.json"),
  };
}

async function prepare(context: ReturnType<typeof fixture>, overrides: TempoOptions = {}) {
  await prepareTempoTransfer(context.runtime, {
    network: "moderato", from: account.address, to: destination, currency: "USDC", amount: "1", format: "tempo", feeToken, out: context.preparedFile,
    ...overrides,
  }, context.dependencies);
  return readArtifact(context.preparedFile, preparedSchema);
}

async function sign(context: ReturnType<typeof fixture>, format: "tempo" | "eip1559" = "tempo") {
  await prepare(context, { format, feeToken: format === "tempo" ? feeToken : undefined });
  await signTempoTransfer(context.runtime, {
    network: "moderato", file: context.preparedFile, out: context.signedFile,
    turnkeyType: format === "tempo" ? "TRANSACTION_TYPE_TEMPO" : "TRANSACTION_TYPE_ETHEREUM",
  }, context.dependencies);
  return readArtifact(context.signedFile, signedSchema);
}

describe("Tempo configuration and reads", () => {
  test("requires a chain independently of the selected Tesser environment", () => {
    expect(() => getTempoConfiguration({ TESSER_BASE_URL: "https://api-staging.tesser.xyz" })).toThrow("Select --network");
    expect(() => getTempoConfiguration({ TEMPO_NETWORK: "moderato" })).toThrow("Select --network");
    expect(getTempoConfiguration({}, "moderato").chainId).toBe(42431);
    expect(getTempoConfiguration({}, "mainnet").chainId).toBe(4217);
    expect(getTempoConfiguration({ TEMPO_MAINNET_RPC_URL: "https://custom.example/key" }, "moderato").rpcUrl).toBe("https://rpc.moderato.tempo.xyz");
  });

  test("keeps accepted mainnet and fixture addresses separate", () => {
    expect(tempoNetworks.mainnet.tokens.USDC.address).toBe("0x20C000000000000000000000b9537d11c60E8b50");
    expect(tempoNetworks.mainnet.tokens.USDT.address).toBe("0x20C00000000000000000000014f22CA97301EB73");
    expect(tempoNetworks.moderato.tokens.USDC.symbol).toBe("AlphaUSD");
    expect(tempoNetworks.moderato.tokens.USDT.symbol).toBe("BetaUSD");
  });

  test("inspects real token identity without any Tesser or Turnkey credentials", async () => {
    const context = runtime();
    const providers = new Providers();
    await inspectTempo({ ...context, environment: {} }, { network: "moderato" }, { fetcher: providers.fetcher });
    expect(context.output.results[0]).toMatchObject({ chain_id: 42431, test_fixture: true, tokens: [
      { currency_mapping: "USDC", token_symbol: "AlphaUSD", decimals: 6 },
      { currency_mapping: "USDT", token_symbol: "BetaUSD", decimals: 6 },
    ] });
    expect(providers.turnkeyCalls).toHaveLength(0);
    expect(providers.calls.some((call) => call.method === "eth_sendRawTransaction")).toBe(false);
  });

  test("stops on an RPC chain mismatch before inspecting contracts", async () => {
    const providers = new Providers();
    providers.chainId = 4217;
    await expect(inspectTempo(runtime(), { network: "moderato" }, { fetcher: providers.fetcher })).rejects.toThrow("chain mismatch");
    expect(providers.calls.map((call) => call.method)).toEqual(["eth_chainId"]);
  });

  test("rejects precision loss and ambiguous noninteractive menus", async () => {
    expect(() => parseAmount("0.0000001", 6)).toThrow("decimal places");
    expect(() => parseAmount("1e3", 6)).toThrow("positive decimal");
    expect(() => parseAmount("0", 6)).toThrow("positive uint256");
    await expect(runTempoMenu(runtime())).rejects.toThrow("subcommand");
  });
});

describe("Tempo preparation and signing", () => {
  for (const format of ["tempo", "eip1559"] as const) {
    test(`prepares and verifies a ${format} EVM-account signature without broadcasting`, async () => {
      const context = fixture();
      const signed = await sign(context, format);
      expect(signed.signed_transaction.startsWith(format === "tempo" ? "0x76" : "0x02")).toBe(true);
      expect(await validateSignature(signed.prepared, signed.signed_transaction)).toBe(signed.transaction_hash);
      expect(context.providers.turnkeyCalls[0]?.body.parameters).toMatchObject({ signWith: account.address, type: signed.turnkey_type });
      expect(context.providers.calls.some((call) => call.method === "eth_sendRawTransaction")).toBe(false);
      expect(statSync(context.signedFile).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(context.runtime.output.results)).not.toContain(signed.signed_transaction);
    });
  }

  test("preserves Turnkey raw recovery bytes and tracks Tempo's canonical hash through the receipt", async () => {
    const context = fixture();
    const prepared = await prepare(context);
    const canonicalTransaction = await signedBytes(prepared.unsigned_transaction);
    const recoveryByte = toHex(Number.parseInt(canonicalTransaction.slice(-2), 16) - 27, { size: 1 }).slice(2);
    const turnkeyTransaction = `${canonicalTransaction.slice(0, -2)}${recoveryByte}` as Hex;
    const expectedHash = keccak256(canonicalTransaction);
    expect(keccak256(turnkeyTransaction)).not.toBe(expectedHash);
    context.providers.signedOverride = turnkeyTransaction;
    context.providers.transactionHashOverride = expectedHash;
    await signTempoTransfer(context.runtime, {
      network: "moderato", file: context.preparedFile, out: context.signedFile, turnkeyType: "TRANSACTION_TYPE_TEMPO",
    }, context.dependencies);
    const signed = readArtifact(context.signedFile, signedSchema);
    expect(signed.signed_transaction).toBe(turnkeyTransaction);
    expect(signed.transaction_hash).toBe(expectedHash);
    await broadcastTempoTransfer(context.runtime, {
      network: "moderato", file: context.signedFile, record: context.recordFile,
    }, context.dependencies);
    expect(context.runtime.output.results.at(-1)).toMatchObject({ status: "submitted", transaction_hash: expectedHash });
    await readTempoReceipt(context.runtime, { network: "moderato", record: context.recordFile }, context.dependencies);
    expect(context.runtime.output.results.at(-1)).toMatchObject({ status: "success", intended_transfer_verified: true, transaction_hash: expectedHash });
    expect(context.providers.calls.filter((call) => call.method === "eth_sendRawTransaction")).toEqual([
      { method: "eth_sendRawTransaction", params: [turnkeyTransaction] },
    ]);
  });

  test("rejects ignored call fields and unsupported recovery bytes", async () => {
    const context = fixture();
    const signed = await sign(context);
    const transactionFields = fromRlp(`0x${signed.signed_transaction.slice(4)}`, "hex");
    const calls = transactionFields[4] as Hex[][];
    calls[0]!.push("0x");
    const extraCallField = `0x76${toRlp(transactionFields).slice(2)}` as Hex;
    await expect(validateSignature(signed.prepared, extraCallField)).rejects.toThrow("does not match");
    const unsupportedRecoveryByte = `${signed.signed_transaction.slice(0, -2)}02` as Hex;
    await expect(validateSignature(signed.prepared, unsupportedRecoveryByte)).rejects.toThrow("does not match");
  });

  test("rejects a changed destination, fee, source, or serialized payload", async () => {
    const context = fixture();
    const signed = await sign(context);
    await expect(validatePrepared({ ...signed.prepared, destination: account.address })).rejects.toThrow("bytes do not match");
    await expect(validatePrepared({ ...signed.prepared, max_fee_per_gas: "999" })).rejects.toThrow("bytes do not match");
    await expect(validateSignature({ ...signed.prepared, source: destination }, signed.signed_transaction)).rejects.toThrow("source address");
    const changedByte = signed.signed_transaction.endsWith("1b") ? "1c" : "1b";
    await expect(validateSignature(signed.prepared, `${signed.signed_transaction.slice(0, -2)}${changedByte}` as Hex)).rejects.toThrow("does not match");
    expect(() => writeArtifact(context.signedFile, {})).toThrow("use a new file");
    expect(readArtifact(context.signedFile, signedSchema).transaction_hash).toBe(signed.transaction_hash);
  });

  test("does not request a signature on mainnet or a mismatched RPC", async () => {
    const context = fixture();
    await prepare(context);
    const options = { network: "mainnet", file: context.preparedFile, out: context.signedFile, turnkeyType: "TRANSACTION_TYPE_TEMPO" };
    const callsBefore = context.providers.calls.length;
    await expect(signTempoTransfer(context.runtime, options, context.dependencies)).rejects.toThrow("Moderato");
    expect(context.providers.calls).toHaveLength(callsBefore);
    context.providers.chainId = 4217;
    await expect(signTempoTransfer(context.runtime, { ...options, network: "moderato" }, context.dependencies)).rejects.toThrow("chain mismatch");
    expect(context.providers.turnkeyCalls).toHaveLength(0);
  });

  test("requires separate explicit Tempo signing credentials", async () => {
    const context = fixture();
    await prepare(context);
    const isolated: TempoRuntime = { ...context.runtime, environment: { SIGNING_PUBLIC_KEY: "existing", SIGNING_PRIVATE_KEY: "existing", SIGNING_ENCLAVE_ID: organizationId } };
    await expect(signTempoTransfer(isolated, { network: "moderato", file: context.preparedFile, out: context.signedFile, turnkeyType: "TRANSACTION_TYPE_TEMPO" }, context.dependencies)).rejects.toThrow("TEMPO_TURNKEY");
    expect(context.providers.turnkeyCalls).toHaveLength(0);
  });

  test("resumes a pending signing activity by reading it instead of requesting another signature", async () => {
    const context = fixture();
    const prepared = await prepare(context);
    context.providers.activityStatus = "ACTIVITY_STATUS_CONSENSUS_NEEDED";
    const options = { network: "moderato", file: context.preparedFile, out: context.signedFile, turnkeyType: "TRANSACTION_TYPE_TEMPO" };
    await signTempoTransfer(context.runtime, options, context.dependencies);
    expect(context.runtime.output.results.at(-1)?.status).toBe("ACTIVITY_STATUS_CONSENSUS_NEEDED");
    context.providers.activityStatus = "ACTIVITY_STATUS_COMPLETED";
    context.providers.preparedForActivity = prepared;
    await signTempoTransfer(context.runtime, { ...options, activityId }, context.dependencies);
    expect(context.providers.turnkeyCalls.map((call) => call.path)).toEqual(["/public/v1/submit/sign_transaction", "/public/v1/query/get_activity"]);
  });

  test("records a rejected activity without creating signed bytes or broadcasting", async () => {
    const context = fixture();
    await prepare(context);
    context.providers.activityStatus = "ACTIVITY_STATUS_REJECTED";
    await expect(signTempoTransfer(context.runtime, {
      network: "moderato", file: context.preparedFile, out: context.signedFile, turnkeyType: "TRANSACTION_TYPE_TEMPO",
    }, context.dependencies)).rejects.toThrow("did not sign");
    expect(context.runtime.output.results.at(-1)?.status).toBe("ACTIVITY_STATUS_REJECTED");
    expect(() => readArtifact(context.signedFile, signedSchema)).toThrow("Could not read");
    expect(context.providers.calls.some((call) => call.method === "eth_sendRawTransaction")).toBe(false);
  });

  test("requires an activity resumed with the same signing type", async () => {
    const context = fixture();
    context.providers.preparedForActivity = await prepare(context);
    await expect(signTempoTransfer(context.runtime, {
      network: "moderato", file: context.preparedFile, out: context.signedFile,
      turnkeyType: "TRANSACTION_TYPE_ETHEREUM", activityId,
    }, context.dependencies)).rejects.toThrow("intent differs");
  });
});

describe("Tempo broadcast and receipt evidence", () => {
  test("saves before balances, sends once, and resumes by record with token and fee evidence", async () => {
    const context = fixture();
    const signed = await sign(context);
    const options = { network: "moderato", file: context.signedFile, record: context.recordFile };
    await broadcastTempoTransfer(context.runtime, options, context.dependencies);
    expect(context.runtime.output.results.at(-1)?.status).toBe("submitted");
    const record = JSON.parse(readFileSync(context.recordFile, "utf8"));
    expect(record.transaction_hash).toBe(signed.transaction_hash);
    expect(record.before.block_number).toBe("100");
    expect(readFileSync(context.recordFile, "utf8")).not.toContain(signed.signed_transaction);
    await broadcastTempoTransfer(context.runtime, options, context.dependencies);
    const receipt = context.runtime.output.results.at(-1);
    expect(receipt).toMatchObject({ status: "success", intended_transfer_verified: true, fee_evidence: { gas_used: "100000" } });
    expect((receipt?.token_movements as unknown[])).toHaveLength(3);
    expect(receipt?.balances).toMatchObject({ available: true, changes: expect.arrayContaining([
      expect.objectContaining({ owner: account.address.toLowerCase(), token_address: feeToken, change_units: "-100" }),
      expect.objectContaining({ owner: destination, token_address: alphaUsd, change_units: "1000000" }),
    ]) });
    expect(context.providers.calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(1);
  });

  test("keeps the hash after a submission timeout and never resubmits an existing record", async () => {
    const context = fixture();
    const signed = await sign(context);
    context.providers.submissionTimeout = true;
    const options = { network: "moderato", file: context.signedFile, record: context.recordFile };
    await expect(broadcastTempoTransfer(context.runtime, options, context.dependencies)).rejects.toThrow("did not return a usable response");
    expect(context.runtime.output.results.at(-1)).toMatchObject({ status: "submission_unconfirmed", transaction_hash: signed.transaction_hash });
    await broadcastTempoTransfer(context.runtime, options, context.dependencies);
    expect(context.runtime.output.results.at(-1)?.status).toBe("not_mined_or_not_found");
    context.providers.mine(signed.transaction_hash);
    await readTempoReceipt(context.runtime, { network: "moderato", record: context.recordFile }, context.dependencies);
    expect(context.runtime.output.results.at(-1)?.status).toBe("success");
    expect(context.providers.calls.filter((call) => call.method === "eth_sendRawTransaction")).toHaveLength(1);
    expect(JSON.stringify(context.runtime.output)).not.toContain(signed.signed_transaction);
  });

  test("blocks broadcasts when the selected network or RPC chain is mainnet", async () => {
    const context = fixture();
    await sign(context);
    const options = { file: context.signedFile, record: context.recordFile };
    await expect(broadcastTempoTransfer(context.runtime, { ...options, network: "mainnet" }, context.dependencies)).rejects.toThrow("Moderato");
    context.providers.chainId = 4217;
    await expect(broadcastTempoTransfer(context.runtime, { ...options, network: "moderato" }, context.dependencies)).rejects.toThrow("chain mismatch");
    expect(context.providers.calls.some((call) => call.method === "eth_sendRawTransaction")).toBe(false);
  });

  test("resumes by hash alone without signing or broadcasting and distinguishes reverted receipts", async () => {
    const context = fixture();
    const hash = toHex(99, { size: 32 });
    context.providers.mine(hash, "0x0");
    await expect(readTempoReceipt(context.runtime, { network: "moderato", hash }, context.dependencies)).rejects.toThrow("reverted");
    expect(context.runtime.output.results.at(-1)).toMatchObject({ status: "reverted", balances: { before_basis: "end of the previous block" } });
    expect(context.providers.turnkeyCalls).toHaveLength(0);
    expect(context.providers.calls.every((call) => call.method !== "eth_sendRawTransaction")).toBe(true);
  });

  test("does not treat a redirected Transfer event as the intended payment", async () => {
    const context = fixture();
    const signed = await sign(context);
    await broadcastTempoTransfer(context.runtime, { network: "moderato", file: context.signedFile, record: context.recordFile }, context.dependencies);
    context.providers.mine(signed.transaction_hash, "0x1", "0x3333333333333333333333333333333333333333");
    await expect(readTempoReceipt(context.runtime, { network: "moderato", record: context.recordFile }, context.dependencies)).rejects.toThrow("does not prove");
    expect(context.runtime.output.results.at(-1)?.intended_transfer_verified).toBe(false);
  });

  test("rejects a receipt hash that conflicts with its local record", async () => {
    const context = fixture();
    await sign(context);
    await broadcastTempoTransfer(context.runtime, { network: "moderato", file: context.signedFile, record: context.recordFile }, context.dependencies);
    await expect(readTempoReceipt(context.runtime, { network: "moderato", record: context.recordFile, hash: toHex(9, { size: 32 }) }, context.dependencies)).rejects.toThrow("does not match");
  });

  test("still reports receipt evidence when historical balance reads are unavailable", async () => {
    const context = fixture();
    const hash = toHex(99, { size: 32 });
    context.providers.mine(hash);
    context.providers.historicalBalancesUnavailable = true;
    await readTempoReceipt(context.runtime, { network: "moderato", hash }, context.dependencies);
    expect(context.runtime.output.results.at(-1)).toMatchObject({ status: "success", balances: { available: false }, token_movements: expect.any(Array) });
  });
});

describe("Tempo sanitized output", () => {
  test("redacts stamps, private keys, and signed bytes in human, JSON, and verbose output", () => {
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const value = { "X-Stamp": "stamp-secret", TEMPO_TURNKEY_PRIVATE_KEY: "private-secret", signedTransaction: "signed-secret", signed_transaction: "signed-secret", unsignedTransaction: "unsigned-secret", token_address: alphaUsd };
      for (const format of ["human", "json"] as const) {
        const output = new Output(format, true);
        output.result(value);
        output.exchange("tempo", value, value);
      }
      const rendered = [...stdout.mock.calls, ...stderr.mock.calls].flat().join("");
      for (const secret of ["stamp-secret", "private-secret", "signed-secret", "unsigned-secret"]) expect(rendered).not.toContain(secret);
      expect(rendered).toContain(alphaUsd);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  test("reports an insufficient-funds category without RPC URLs or provider error payloads", async () => {
    const context = fixture();
    context.providers.estimateError = true;
    await expect(prepare(context)).rejects.toThrow("insufficient funds");
    expect(JSON.stringify(context.runtime.output)).not.toContain("private-secret");
    expect(JSON.stringify(context.runtime.output)).not.toContain("https://rpc");
  });
});
