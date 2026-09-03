import pc from "picocolors";

const sensitiveNames = new Set([
  "access_token",
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
  "stamp",
  "stampheadervalue",
  "token",
  "webhooksecret",
  "webhook_signing_key",
  "withdrawal_fee_token",
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
  if (normalized === "unsigned_transaction" && typeof value === "string") {
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
      `${JSON.stringify(sanitize({ operation, request, response }), null, 2)}\n`,
    );
  }

  result(value: unknown): void {
    process.stdout.write(`${JSON.stringify(sanitize(value), null, 2)}\n`);
  }

  error(message: string): void {
    process.stderr.write(`${pc.red(`Error: ${message}`)}\n`);
  }
}

function compact(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 157)}…` : value;
  const rendered = JSON.stringify(value);
  return rendered.length > 160 ? `${rendered.slice(0, 157)}…` : rendered;
}
