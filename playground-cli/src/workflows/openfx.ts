import { readFileSync } from "node:fs";
import { z } from "zod";
import { firstValue, positiveNumber } from "../config.ts";
import { ApiError, UsageError } from "../errors.ts";
import { parseResponseBody, requireData, requireSuccess } from "../http.ts";
import type { Runtime } from "../runtime.ts";
import { listAccounts } from "../accounts.ts";

const openFxKeySchema = z.object({
  orgId: z.string().min(1),
  id: z.string().min(1),
  privateKey: z.string().min(1),
});

export async function registerOpenFx(
  runtime: Runtime,
  apiKeyFileInput: string | undefined,
): Promise<void> {
  const apiKeyFile = await runtime.interaction.text("OpenFX API key JSON path", apiKeyFileInput);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(apiKeyFile, "utf8"));
  } catch (cause) {
    throw new UsageError(`Could not read OpenFX API key file ${apiKeyFile}`, { cause });
  }
  const parsed = openFxKeySchema.safeParse(raw);
  if (!parsed.success) throw new UsageError(`Invalid OpenFX API key file: ${parsed.error.message}`);
  const privateKey = parsed.data.privateKey.replaceAll("\\n", "\n").trim();
  if (!privateKey.startsWith("-----BEGIN") || !privateKey.includes("PRIVATE KEY-----")) {
    throw new UsageError("OpenFX API key file contains an invalid privateKey");
  }
  const webhookSecret = await runtime.interaction.secret(
    "OpenFX webhook signing secret",
    firstValue(runtime.environment, "OPENFX_WEBHOOK_SIGNING_KEY"),
  );
  await runtime.interaction.approve("registering the OpenFX credentials");
  const response = await runtime.client.request("POST", "/v1/organizations/secrets", {
    headers: { "x-api-client": "true" },
    body: {
      provider: "OPENFX",
      key: "OPENFX_CREDENTIALS",
      value: {
        orgId: parsed.data.orgId,
        apiKey: parsed.data.id,
        privateKey,
        webhookSecret,
      },
    },
    operation: "Register OpenFX credentials",
  });
  runtime.output.result(requireSuccess(response, "Register OpenFX credentials"));
}

export async function showOpenFxWebhookUrl(runtime: Runtime): Promise<void> {
  const accounts = await listAccounts(runtime.client);
  const workspaceIds = new Set(
    accounts.map((account) => account.workspace_id).filter((value): value is string => Boolean(value)),
  );
  if (workspaceIds.size !== 1) {
    throw new UsageError(
      workspaceIds.size === 0
        ? "Could not infer the workspace ID because the workspace has no accounts"
        : "Account results contained more than one workspace ID",
    );
  }
  runtime.output.result({
    webhookUrl: `${runtime.client.configuration.baseUrl}/v1/webhooks/openfx/${[...workspaceIds][0]}`,
  });
}

export async function patchBasisTheory(
  runtime: Runtime,
  tokenOverride: string | undefined,
): Promise<void> {
  const token = await runtime.interaction.secret(
    "Basis Theory token",
    tokenOverride ?? firstValue(runtime.environment, "BASIS_THEORY_TOKEN"),
  );
  const apiKey = await runtime.interaction.secret(
    "Basis Theory API key",
    firstValue(runtime.environment, "BASIS_THEORY_API_KEY"),
  );
  const webhookSecret = await runtime.interaction.secret(
    "OpenFX webhook signing secret",
    firstValue(runtime.environment, "OPENFX_WEBHOOK_SIGNING_KEY"),
  );
  const baseUrl = firstValue(runtime.environment, "BASIS_THEORY_BASE_URL") ?? "https://api.basistheory.com";
  const timeoutSeconds = positiveNumber(
    firstValue(runtime.environment, "TESSER_TIMEOUT_SECONDS"),
    "TESSER_TIMEOUT_SECONDS",
    30,
  );
  await runtime.interaction.approve("patching the Basis Theory OpenFX credentials");
  const url = `${baseUrl.replace(/\/$/, "")}/tokens/${encodeURIComponent(token)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PATCH",
      headers: {
        "BT-API-KEY": apiKey,
        "Content-Type": "application/merge-patch+json",
        Accept: "application/json",
      },
      body: JSON.stringify({ data: { OPENFX_CREDENTIALS: { webhookSecret } } }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (cause) {
    throw new ApiError("Basis Theory PATCH request failed", undefined, undefined, { cause });
  }
  const body = await parseResponseBody(response);
  runtime.output.exchange(
    "Patch Basis Theory OpenFX credentials",
    {
      method: "PATCH",
      url: `${baseUrl.replace(/\/$/, "")}/tokens/<redacted>`,
      headers: { "BT-API-KEY": apiKey },
      body: { data: { OPENFX_CREDENTIALS: { webhookSecret } } },
    },
    { status: response.status, body },
  );
  if (!response.ok) throw new ApiError(`Basis Theory patch failed with HTTP ${response.status}`, response.status, body);
  runtime.output.result(body);
}

export async function deleteBasisTheory(
  runtime: Runtime,
  tokenOverride: string | undefined,
): Promise<void> {
  const token = await runtime.interaction.secret(
    "Basis Theory token",
    tokenOverride ?? firstValue(runtime.environment, "BASIS_THEORY_TOKEN"),
  );
  const apiKey = await runtime.interaction.secret(
    "Basis Theory API key",
    firstValue(runtime.environment, "BASIS_THEORY_API_KEY"),
  );
  const baseUrl = firstValue(runtime.environment, "BASIS_THEORY_BASE_URL") ?? "https://api.basistheory.com";
  const timeoutSeconds = positiveNumber(
    firstValue(runtime.environment, "TESSER_TIMEOUT_SECONDS"),
    "TESSER_TIMEOUT_SECONDS",
    30,
  );
  await runtime.interaction.approve("deleting the Basis Theory token");
  const url = `${baseUrl.replace(/\/$/, "")}/tokens/${encodeURIComponent(token)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "DELETE",
      headers: {
        "BT-API-KEY": apiKey,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
  } catch (cause) {
    throw new ApiError("Basis Theory DELETE request failed", undefined, undefined, { cause });
  }
  const body = await parseResponseBody(response);
  runtime.output.exchange(
    "Delete Basis Theory token",
    {
      method: "DELETE",
      url: `${baseUrl.replace(/\/$/, "")}/tokens/<redacted>`,
      headers: { "BT-API-KEY": apiKey },
    },
    { status: response.status, body },
  );
  if (!response.ok && response.status !== 404) {
    throw new ApiError(`Basis Theory delete failed with HTTP ${response.status}`, response.status, body);
  }
  runtime.output.result({ deleted: response.ok, alreadyDeleted: response.status === 404 });
}

export type BankAccountOptions = {
  name?: string;
  bankName?: string;
  bankCodeType?: string;
  bankIdentifierCode?: string;
  bankSwiftCode?: string;
  accountNumber?: string;
  yes?: boolean;
};

export async function createBankAccount(runtime: Runtime, options: BankAccountOptions): Promise<void> {
  const body = {
    name: await runtime.interaction.text("Account name", options.name, "OpenFX Sandbox USD Account"),
    bank_name: await runtime.interaction.text("Bank name", options.bankName, "OpenFX Sandbox Bank"),
    bank_code_type: await runtime.interaction.text("Bank code type", options.bankCodeType, "SWIFT"),
    bank_identifier_code: await runtime.interaction.text("Bank identifier code", options.bankIdentifierCode, "FAKEUSXX"),
    bank_swift_code: await runtime.interaction.text("Bank SWIFT code", options.bankSwiftCode, "FAKEUSXX"),
    bank_account_number: await runtime.interaction.text("Bank account number", options.accountNumber, "0000000000"),
  };
  if (!options.yes) await runtime.interaction.approve("creating the workspace bank account");
  const response = await runtime.client.request("POST", "/v1/accounts/banks", {
    body,
    operation: "Create workspace bank account",
  });
  runtime.output.result(requireData(response, "Create workspace bank account"));
}
