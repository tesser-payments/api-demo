import pc from "picocolors";

const sensitiveNames = new Set([
  "access_token",
  "admin_api_secret",
  "api-key",
  "api-sign",
  "api-secret",
  "apikey",
  "apisecret",
  "authorization",
  "bt-api-key",
  "client_secret",
  "private_key",
  "privatekey",
  "kraken_api_key",
  "kraken_api_secret",
  "krakenapikey",
  "krakenapisecret",
  "signature",
  "signing_private_key",
  "tempo_turnkey_private_key",
  "signed_transaction",
  "signedtransaction",
  "raw_transaction",
  "rawtransaction",
  "stamp",
  "stampheadervalue",
  "token",
  "webhooksecret",
  "webhook_signing_key",
  "withdrawal_fee_token",
  "x-admin-secret",
  "x-stamp",
]);

export function sanitize(value: unknown, fieldName?: string): unknown {
  const normalized = fieldName?.toLowerCase();
  if (normalized && sensitiveNames.has(normalized)) return "<redacted>";
  if (
    (normalized === "bank_account_number" || normalized === "bankaccountnumber") &&
    typeof value === "string"
  ) {
    return `${"•".repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
  }
  if ((normalized === "unsigned_transaction" || normalized === "unsignedtransaction") && typeof value === "string") {
    return `<unsigned-transaction:${value.length} chars>`;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitize(item, key)]),
    );
  }
  return value;
}

export class Output {
  constructor(
    readonly format: "human" | "json",
    readonly verbose: boolean,
  ) {}

  info(message: string): void {
    if (this.format === "human") process.stdout.write(`${message}\n`);
    else process.stderr.write(`${message}\n`);
  }

  progress(event: string, values: Record<string, unknown> = {}): void {
    if (this.verbose || this.format === "json") return;
    const payload = sanitize({ event, ...values });
    const fields = Object.entries(payload as Record<string, unknown>)
      .filter(([name]) => name !== "event")
      .map(([name, value]) => `${name}=${compact(value)}`)
      .join(" ");
    this.info(`${pc.cyan(`[${event}]`)}${fields ? ` ${fields}` : ""}`);
  }

  exchange(
    operation: string,
    request: Record<string, unknown>,
    response: Record<string, unknown>,
  ): void {
    if (!this.verbose) return;
    process.stderr.write(
      `${JSON.stringify(sanitize(maskExchangeWalletAddresses({ operation, request, response })), null, 2)}\n`,
    );
  }

  result(value: unknown): void {
    process.stdout.write(`${JSON.stringify(sanitize(value), null, 2)}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${pc.red(`Error: ${message}`)}\n`);
  }
}

function maskExchangeWalletAddresses(value: unknown, fieldName?: string): unknown {
  if (
    typeof value === "string" &&
    ["address", "expected_address", "crypto_wallet_address"].includes(fieldName?.toLowerCase() ?? "") &&
    /^0x[0-9a-fA-F]{40}$/.test(value)
  ) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  if (Array.isArray(value)) return value.map((item) => maskExchangeWalletAddresses(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, maskExchangeWalletAddresses(item, key)]),
    );
  }
  return value;
}

function compact(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  const rendered = JSON.stringify(value);
  return rendered.length > 160 ? `${rendered.slice(0, 157)}…` : rendered;
}
