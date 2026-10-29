// Wire shapes (snake_case) for the fields this repo reads. Source: the Tesser
// OpenAPI schema (https://docs.tesser.xyz/api/v1/schema.json).
// `@tesser-payments/types` is camelCase and doesn't match what the API returns.

export interface Envelope<T> {
  data: T;
}

export type StepStatus =
  | "created"
  | "signature_requested"
  | "signed"
  | "submitted"
  | "confirmed"
  | "completed"
  | "failed";

export type RiskStatus =
  | "unchecked"
  | "awaiting_decision"
  | "automatically_approved"
  | "manually_approved"
  | "automatically_rejected"
  | "manually_rejected";

export type BalanceStatus = "unreserved" | "awaiting_funds" | "reserved";

export type AccountType =
  | "fiat_bank"
  | "stablecoin_ethereum"
  | "stablecoin_solana"
  | "stablecoin_stellar"
  | "ledger"
  | "generic";

export interface Asset {
  currency: string;
  network?: string;
  available_balance: string;
}

export interface Account {
  id: string;
  workspace_id: string;
  tenant_id?: string | null;
  counterparty_id?: string | null;
  type: AccountType;
  name: string;
  provider?: string | null;
  crypto_wallet_address?: string | null;
  is_managed?: boolean | null;
  created_by: "CUSTOMER" | "SYSTEM";
  assets?: Asset[];
  created_at: string;
  updated_at: string;
}

export interface Leg {
  account_id: string | null;
  amount: string | null;
  currency: string | null;
  network: string | null;
}

export interface Overlay {
  from: Leg;
  to: Leg;
}

export interface StatusReason {
  error_code: string;
  error_message: string;
}

/** A payment or deposit step; both share this shape. */
export interface Step {
  id: string;
  step_sequence: number;
  step_type: "transfer" | "swap";
  estimated: Overlay;
  actual: Overlay;
  provider_key?: string | null;
  status: StepStatus;
  status_reasons?: StatusReason[] | null;
  transaction_hash?: string | null;
  created_at: string;
  updated_at: string;
  submitted_at?: string | null;
  confirmed_at?: string | null;
  completed_at?: string | null;
  failed_at?: string | null;
}

export interface Payment {
  id: string;
  workspace_id: string;
  organization_reference_id?: string | null;
  direction: "inbound" | "outbound" | "rebalance";
  funding_account_id: string | null;
  desired: Overlay;
  estimated: Overlay;
  actual: Overlay;
  risk_status: RiskStatus | null;
  balance_status: BalanceStatus | null;
  steps: Step[];
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface Deposit {
  id: string;
  workspace_id: string;
  organization_reference_id?: string | null;
  direction: "inbound";
  desired: Overlay;
  estimated: Overlay;
  actual: Overlay;
  steps?: Step[];
  created_at: string;
  updated_at: string;
  expires_at?: string | null;
}
