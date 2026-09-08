import { ApiKeyStamper } from "@turnkey/api-key-stamper";
import { z } from "zod";
import { firstValue, type Environment } from "../config.ts";
import { PlaygroundError, UsageError } from "../errors.ts";
import type { Output } from "../output.ts";
import type { PreparedTransaction } from "./artifacts.ts";
import type { TempoFetch } from "./rpc.ts";

export const turnkeyTypeSchema = z.enum(["TRANSACTION_TYPE_ETHEREUM", "TRANSACTION_TYPE_TEMPO"]);
export type TurnkeyType = z.infer<typeof turnkeyTypeSchema>;

export type TempoSigningConfiguration = {
  publicKey: string;
  privateKey: string;
  organizationId: string;
};

export function getTempoSigningConfiguration(environment: Environment): TempoSigningConfiguration {
  const publicKey = firstValue(environment, "TEMPO_TURNKEY_PUBLIC_KEY");
  const privateKey = firstValue(environment, "TEMPO_TURNKEY_PRIVATE_KEY");
  const organizationId = firstValue(environment, "TEMPO_TURNKEY_ORGANIZATION_ID");
  if (!publicKey || !privateKey || !organizationId || !z.uuid().safeParse(organizationId).success) {
    throw new UsageError("Signing requires TEMPO_TURNKEY_PUBLIC_KEY, TEMPO_TURNKEY_PRIVATE_KEY, and TEMPO_TURNKEY_ORGANIZATION_ID for the chosen test account");
  }
  return { publicKey, privateKey, organizationId };
}

export type StampRequest = (body: string, configuration: TempoSigningConfiguration) => Promise<string>;

export async function stampTurnkeyRequest(body: string, configuration: TempoSigningConfiguration): Promise<string> {
  const stamped = await new ApiKeyStamper({ apiPublicKey: configuration.publicKey, apiPrivateKey: configuration.privateKey }).stamp(body);
  return stamped.stampHeaderValue;
}

export async function signTempoTransaction(input: {
  prepared: PreparedTransaction;
  transactionType: TurnkeyType;
  configuration: TempoSigningConfiguration;
  output: Output;
  activityId?: string;
  fetcher?: TempoFetch;
  stamp?: StampRequest;
}) {
  const { prepared, configuration, transactionType, activityId, output } = input;
  if (activityId && !z.uuid().safeParse(activityId).success) throw new UsageError("Turnkey activity ID must be a UUID");
  const body = JSON.stringify(activityId ? {
    organizationId: configuration.organizationId,
    activityId,
  } : {
    type: "ACTIVITY_TYPE_SIGN_TRANSACTION_V2",
    timestampMs: String(Date.now()),
    organizationId: configuration.organizationId,
    parameters: {
      signWith: prepared.source,
      unsignedTransaction: prepared.unsigned_transaction,
      type: transactionType,
    },
  });
  let response: Response;
  let payload: unknown;
  try {
    const stamp = await (input.stamp ?? stampTurnkeyRequest)(body, configuration);
    response = await (input.fetcher ?? fetch)(
      `https://api.turnkey.com/public/v1/${activityId ? "query/get_activity" : "submit/sign_transaction"}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Stamp": stamp },
        body,
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) throw new PlaygroundError(`Turnkey ${activityId ? "activity lookup" : "signing"} failed (HTTP ${response.status}); no transaction was broadcast`);
    payload = await response.json();
  } catch (error) {
    if (error instanceof PlaygroundError) throw error;
    throw new PlaygroundError("Turnkey did not return a usable signing response; check its activity history before retrying. No transaction was broadcast");
  }
  const parsed = z.object({
    activity: z.object({
      id: z.uuid(),
      organizationId: z.literal(configuration.organizationId),
      type: z.literal("ACTIVITY_TYPE_SIGN_TRANSACTION_V2"),
      status: z.enum([
        "ACTIVITY_STATUS_CREATED", "ACTIVITY_STATUS_PENDING", "ACTIVITY_STATUS_CONSENSUS_NEEDED",
        "ACTIVITY_STATUS_COMPLETED", "ACTIVITY_STATUS_FAILED", "ACTIVITY_STATUS_REJECTED",
      ]),
      intent: z.object({ signTransactionIntentV2: z.object({
        signWith: z.string(),
        unsignedTransaction: z.string(),
        type: turnkeyTypeSchema,
      }) }),
      result: z.object({ signTransactionResult: z.object({ signedTransaction: z.string().regex(/^(0x)?(?:[0-9a-fA-F]{2})+$/) }).optional() }).optional(),
    }),
  }).safeParse(payload);
  if (!parsed.success || (activityId && parsed.data.activity.id !== activityId)) {
    throw new PlaygroundError("Turnkey returned an invalid or mismatched signing activity; no transaction was broadcast");
  }
  const activity = parsed.data.activity;
  const intent = activity.intent.signTransactionIntentV2;
  if (
    intent.signWith.toLowerCase() !== prepared.source.toLowerCase() ||
    intent.unsignedTransaction.replace(/^0x/, "").toLowerCase() !== prepared.unsigned_transaction.slice(2).toLowerCase() ||
    intent.type !== transactionType
  ) throw new PlaygroundError("Turnkey activity intent differs from the selected signing experiment");
  output.exchange("tempo-turnkey", { operation: activityId ? "get_activity" : "sign_transaction", transaction_type: transactionType }, { activity_id: activity.id, status: activity.status });
  const bytes = activity.result?.signTransactionResult?.signedTransaction;
  if (activity.status === "ACTIVITY_STATUS_COMPLETED" && !bytes) {
    throw new PlaygroundError("Turnkey completed the activity without a signed transaction");
  }
  return {
    activity_id: activity.id,
    status: activity.status,
    signed_transaction: activity.status === "ACTIVITY_STATUS_COMPLETED" && bytes ? (bytes.startsWith("0x") ? bytes : `0x${bytes}`) as `0x${string}` : undefined,
  };
}
