import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { z } from "zod";
import { UsageError } from "./errors.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

const tesserSchema = z.object({
  TESSER_BASE_URL: z.url(),
  TESSER_AUTH_URL: z.url(),
  TESSER_AUDIENCE: z.string().min(1),
  TESSER_CLIENT_ID: z.string().min(1),
  TESSER_CLIENT_SECRET: z.string().min(1),
  TESSER_TIMEOUT_SECONDS: z.coerce.number().positive().default(30),
});

const signingSchema = z.object({
  SIGNING_PUBLIC_KEY: z.string().min(1),
  SIGNING_PRIVATE_KEY: z.string().min(1),
  SIGNING_ENCLAVE_ID: z.string().min(1),
});

const krakenSchema = z.object({
  KRAKEN_API_KEY: z.string().min(1),
  KRAKEN_API_SECRET: z.string().min(1),
  KRAKEN_BASE_URL: z.preprocess(
    emptyStringToUndefined,
    z.url().default("https://api.kraken.com"),
  ),
  KRAKEN_REQUEST_TIMEOUT_SECONDS: z.coerce.number().positive().default(30),
});

export type TesserConfiguration = {
  baseUrl: string;
  authUrl: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  timeoutSeconds: number;
};

export type SigningConfiguration = {
  publicKey: string;
  privateKey: string;
  enclaveId: string;
};

export type KrakenConfiguration = {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  timeoutSeconds: number;
};

function emptyStringToUndefined(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim() || undefined;
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join(", ");
}

export function loadEnvironment(
  envFile: string | undefined,
  inheritedEnvironment: NodeJS.ProcessEnv = process.env,
): Environment {
  let fileValues: Record<string, string> = {};
  if (envFile) {
    const absolutePath = resolve(envFile);
    try {
      fileValues = parse(readFileSync(absolutePath));
    } catch (cause) {
      throw new UsageError(`Could not read env file ${absolutePath}`, { cause });
    }
  }
  return { ...fileValues, ...inheritedEnvironment };
}

export function getTesserConfiguration(environment: Environment): TesserConfiguration {
  const values = {
    ...environment,
    TESSER_AUDIENCE:
      environment.TESSER_AUDIENCE ?? environment.TESSER_BASE_URL,
  };
  const result = tesserSchema.safeParse(values);
  if (!result.success) {
    throw new UsageError(`Invalid Tesser configuration: ${validationMessage(result.error)}`);
  }
  return {
    baseUrl: result.data.TESSER_BASE_URL.replace(/\/$/, ""),
    authUrl: result.data.TESSER_AUTH_URL,
    audience: result.data.TESSER_AUDIENCE,
    clientId: result.data.TESSER_CLIENT_ID,
    clientSecret: result.data.TESSER_CLIENT_SECRET,
    timeoutSeconds: result.data.TESSER_TIMEOUT_SECONDS,
  };
}

export function getSigningConfiguration(environment: Environment): SigningConfiguration {
  const result = signingSchema.safeParse(environment);
  if (!result.success) {
    throw new UsageError(`Invalid signing configuration: ${validationMessage(result.error)}`);
  }
  return {
    publicKey: result.data.SIGNING_PUBLIC_KEY,
    privateKey: result.data.SIGNING_PRIVATE_KEY,
    enclaveId: result.data.SIGNING_ENCLAVE_ID,
  };
}

export function getKrakenConfiguration(environment: Environment): KrakenConfiguration {
  const result = krakenSchema.safeParse(environment);
  if (!result.success) {
    throw new UsageError(`Invalid Kraken configuration: ${validationMessage(result.error)}`);
  }
  return {
    apiKey: result.data.KRAKEN_API_KEY,
    apiSecret: result.data.KRAKEN_API_SECRET,
    baseUrl: result.data.KRAKEN_BASE_URL.replace(/\/$/, ""),
    timeoutSeconds: result.data.KRAKEN_REQUEST_TIMEOUT_SECONDS,
  };
}

export function firstValue(
  environment: Environment,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function positiveNumber(
  value: string | number | undefined,
  name: string,
  fallback: number,
): number {
  const parsed = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new UsageError(`${name} must be greater than zero`);
  }
  return parsed;
}
