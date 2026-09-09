import { readFileSync } from "node:fs";
import { z } from "zod";
import { chooseAccount, listAccounts, type Account } from "../accounts.ts";
import { getKrakenConfiguration } from "../config.ts";
import { UsageError } from "../errors.ts";
import { requireSuccess } from "../http.ts";
import { KrakenFundingClient, type KrakenFundingApi } from "../kraken.ts";
import { sanitize } from "../output.ts";
import type { Runtime } from "../runtime.ts";

const requiredText = z.string().trim().min(1);
const nullableText = requiredText.nullable();

const cadInstructionsSchema = z.object({
  methodId: requiredText,
  bankName: requiredText,
  bankAccountNumber: requiredText,
  bankCodeType: requiredText,
  bankIdentifierCode: requiredText,
  bankSwiftCode: nullableText,
  beneficiaryName: requiredText,
  beneficiaryAddress: nullableText,
  trackingReference: nullableText,
});

type CadInstructions = z.infer<typeof cadInstructionsSchema>;

type KrakenFundingMethod = {
  asset?: { name?: string };
  method_id?: string;
  method_name?: string;
};

export type KrakenRegisterSecretsOptions = {
  cadInstructionsFile?: string;
};

export async function runKrakenRegisterSecrets(
  runtime: Runtime,
  options: KrakenRegisterSecretsOptions,
  fundingApi?: KrakenFundingApi,
): Promise<void> {
  const existingLedgers = await findKrakenLedgers(runtime);
  if (existingLedgers.length) {
    throw new UsageError("Kraken secrets are already registered for this workspace");
  }
  const instructionsFile = options.cadInstructionsFile;
  const cadInstructions = instructionsFile
    ? readCadInstructions(instructionsFile)
    : await claimCadInstructions(runtime, fundingApi);
  runtime.output.info(
    JSON.stringify(
      sanitize({
        event: "kraken.register-secrets.review",
        depositInstructions: { CAD: cadInstructions },
      }),
      null,
      2,
    ),
  );
  await runtime.interaction.approve("registering the Kraken secrets");
  const configuration = getKrakenConfiguration(runtime.environment);
  const response = await runtime.client.request(
    "POST",
    "/v1/organizations/secrets",
    {
      headers: { "x-api-client": "true" },
      body: {
        provider: "KRAKEN",
        key: "KRAKEN_CREDENTIALS",
        value: {
          apiKey: configuration.apiKey,
          apiSecret: configuration.apiSecret,
          depositInstructions: { CAD: cadInstructions },
        },
      },
      operation: "Register Kraken secrets",
    },
  );
  const registration = requireSuccess(response, "Register Kraken secrets");
  const ledgers = await findKrakenLedgers(runtime);
  const ledger = await chooseAccount(
    runtime.interaction,
    "Managed Kraken ledger",
    ledgers,
  );
  assertLedgerAssets(ledger);
  runtime.output.result({ registration, ledger });
}

async function claimCadInstructions(
  runtime: Runtime,
  fundingApi?: KrakenFundingApi,
): Promise<CadInstructions> {
  if (!runtime.interaction.interactive) {
    throw new UsageError(
      "--cad-instructions-file is required in non-interactive mode",
    );
  }
  const client =
    fundingApi ??
    new KrakenFundingClient(
      getKrakenConfiguration(runtime.environment),
      runtime.output,
    );
  const methodsResponse = await client.request(
    "GET",
    "/funding/v1/methods/deposit",
    {
      query: {
        asset: { class: "currency", name: "CAD" },
        limit: 500,
      },
      operation: "List Kraken CAD deposit funding methods",
    },
  );
  const methods = requireMethods(methodsResponse).filter(
    (method) => method.asset?.name?.toUpperCase() === "CAD",
  );
  const method = methods[0];
  if (!method?.method_id) {
    throw new UsageError("Kraken returned no CAD deposit funding method");
  }
  runtime.output.progress("kraken.cad-method.selected", {
    methodId: method.method_id,
    methodName: method.method_name,
  });
  runtime.output.info(
    "Open Kraken Web, select CAD deposit, choose the displayed funding method, and copy its bank instructions.",
  );
  return cadInstructionsSchema.parse({
    methodId: method.method_id,
    bankName: await runtime.interaction.text(
      "CAD bank name",
    ),
    bankAccountNumber: await runtime.interaction.secret(
      "CAD bank account number",
    ),
    bankCodeType: await runtime.interaction.text(
      "CAD bank code type",
    ),
    bankIdentifierCode: await runtime.interaction.text(
      "CAD bank identifier code",
    ),
    bankSwiftCode:
      (await runtime.interaction.optionalText(
        "CAD bank SWIFT code",
      )) ?? null,
    beneficiaryName: await runtime.interaction.text(
      "CAD beneficiary name",
    ),
    beneficiaryAddress:
      (await runtime.interaction.optionalText(
        "CAD beneficiary address",
      )) ?? null,
    trackingReference:
      (await runtime.interaction.optionalText(
        "CAD tracking reference",
      )) ?? null,
  });
}

function readCadInstructions(path: string): CadInstructions {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new UsageError(`Could not read Kraken CAD instructions file ${path}`, {
      cause,
    });
  }
  const parsed = cadInstructionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(
      `Invalid Kraken CAD instructions file: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

async function findKrakenLedgers(runtime: Runtime): Promise<Account[]> {
  return (await listAccounts(runtime.client, [["type", "ledger"]])).filter(
    (account) =>
      account.type === "ledger" &&
      account.provider === "KRAKEN" &&
      account.is_managed === true,
  );
}

function assertLedgerAssets(ledger: Account): void {
  const currencies = new Set(
    ledger.assets?.map((asset) => asset.currency).filter(Boolean),
  );
  const missing = ["BRL", "CAD", "USDC", "USDT"].filter(
    (currency) => !currencies.has(currency),
  );
  if (missing.length) {
    throw new UsageError(
      `Managed Kraken ledger is missing assets: ${missing.join(", ")}`,
    );
  }
}

function requireMethods(response: Record<string, unknown>): KrakenFundingMethod[] {
  if (!Array.isArray(response.methods)) {
    throw new UsageError(
      "Kraken funding-method response did not contain methods",
    );
  }
  return response.methods as KrakenFundingMethod[];
}
