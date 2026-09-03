# Tesser Playground CLI

A standalone Bun and TypeScript playground for authenticated Tesser API requests, payments, inbound simulations, OpenFX setup, Kraken funding probes, withdrawals, and rebalances.

## Setup

```bash
cd playground-cli
bun install
cp .env.example sandbox.env
```

The CLI never loads `.env` or `.env.local` automatically. Interactive mode scans the
current directory for `*.env` files and asks which one to use before opening a command:

```bash
./cli
```

Default and template files such as `.env`, `.env.local`, and `config.example.env` are
excluded from the choices. You can also select process environment only, enter another
path, or exit. Pass a file explicitly to skip this prompt:

```bash
./cli --env-file sandbox.env
```

Configuration already present in the calling process overrides the selected file:

```bash
TESSER_BASE_URL=http://localhost:9000 ./cli --env-file sandbox.env request GET /v1/accounts
```

Precedence is command options, calling-process environment, selected env file, then non-secret defaults.

## Interactive mode

```bash
./cli --env-file sandbox.env
./cli --env-file sandbox.env payment
./cli --env-file sandbox.env withdrawal --with-ui
./cli --env-file sandbox.env rebalance --with-ui
./cli --env-file sandbox.env kraken
./cli --env-file staging.env kraken deposit --with-ui
./cli --env-file staging.env kraken funding deposit --with-ui
./cli --env-file staging.env kraken swap --with-ui
./cli --env-file staging.env kraken withdraw send --with-ui
```

With no command, the CLI opens a command menu. Explicit commands prompt for missing values and confirm mutations.
The selected environment is retained while the command menu remains open.
The withdrawal flow shows its resolved values before authentication. Press Enter on
`Use these values` to continue, or select any field to edit it and return to the review menu.
It also asks whether to enable the withdrawal UI, defaulting to disabled. Pass `--with-ui`
to enable it without that prompt.

The withdrawal UI is a dependency-free HTML file with embedded CSS and JavaScript. It
shows the CLI, Tesser, signer, blockchain, OpenFX, and bank as a live sequence diagram.
Select a transfer step to inspect its timestamps, failure reasons, transaction state,
and sanitized JSON. On narrow screens, the diagram becomes a vertical event timeline.

The rebalance flow moves funds from a managed wallet to an OpenFX ledger. It signs the
wallet transaction locally, waits for the matching OpenFX sandbox mock deposit, and
then follows any ledger swap through completion. Its live UI is written to
`ui/rebalance/index.html` and shows the mock-deposit boundary in the sequence diagram.

The Kraken menu registers Kraken secrets with Tesser, runs end-to-end BRL deposits,
shows balances, performs USD-to-USDC market swaps, and sends USDC withdrawals. Direct
deposit diagnostics and withdrawals use Funding Beta; balances and swaps use Spot REST.
Add `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` to the selected environment file. Enable
Query Funds and Deposit Funds for registration and BRL deposits. Enable Create/Modify
Orders, Query Open Orders, Query Closed Orders, Withdraw Funds, and Add Withdrawal
Addresses for the other direct Kraken workflows.
Set `KRAKEN_BASE_URL` in each environment that needs a different Kraken API endpoint.
An unset or empty value uses `https://api.kraken.com`.

`kraken register_secrets` claims the first CAD method's instructions or reads normalized
instructions from `--cad-instructions-file`, then registers the credentials through
Tesser. `kraken deposit` creates the Tesser BRL plan, verifies the non-payable Staging
instructions, pauses for the real `Pix (PayAmigo)` deposit in Kraken Web, and polls
Tesser until reconciliation completes. Swap validates the market order before asking
for confirmation. Withdraw has a submenu for registering a new onchain target or
sending to an existing verified target. Registering a target returns to the withdrawal
submenu and does not move funds.

The Tesser BRL deposit, direct Funding API deposit, swap, and withdrawal send flows ask
whether to enable a live UI, defaulting to disabled. Pass `--with-ui` to skip the prompt.
Their dashboards are written under `ui/kraken/<command>/index.html` and update while
the CLI polls Kraken or Tesser.

```bash
./cli --env-file staging.env kraken register_secrets
./cli --env-file staging.env kraken deposit --amount 50.00
```

Non-interactive registration requires a normalized CAD instructions file:

```json
{
  "methodId": "<first-cad-method-id>",
  "bankName": "<bank-name>",
  "bankAccountNumber": "<account-number>",
  "bankCodeType": "<code-type>",
  "bankIdentifierCode": "<identifier>",
  "bankSwiftCode": null,
  "beneficiaryName": "<beneficiary>",
  "beneficiaryAddress": null,
  "trackingReference": null
}
```

## Non-interactive mode

```bash
./cli \
  --env-file sandbox.env \
  --non-interactive \
  --output json \
  request GET /v1/accounts
```

Non-interactive mode never reads from the terminal. Missing or ambiguous values fail before the affected operation.
Without `--env-file`, it uses only the calling-process environment.

## Commands

```bash
./cli request METHOD PATH
./cli payment [destination-wallet-address]
./cli withdrawal
./cli rebalance
./cli wallet-address
./cli simulate-inbound
./cli kraken
./cli kraken balances
./cli kraken register_secrets
./cli kraken deposit [--with-ui]
./cli kraken deposit --deposit-id [tesser-deposit-id]
./cli kraken funding deposit [--with-ui]
./cli kraken funding deposit show [kraken-deposit-id]
./cli kraken swap [--with-ui]
./cli kraken withdraw
./cli kraken withdraw register-address
./cli kraken withdraw send [--with-ui]
./cli openfx register [api-key-file]
./cli openfx webhook-url
./cli openfx patch-basis-theory
./cli openfx delete-basis-theory
./cli openfx create-bank-account
```

Use `./cli <command> --help` for command options.

## Request bodies

```bash
./cli --env-file sandbox.env request POST /v1/payments --data '{"desired":{}}'
./cli --env-file sandbox.env request POST /v1/payments --data-file payment.json
printf '%s' '{"desired":{}}' | ./cli --env-file sandbox.env request POST /v1/payments --data-file -
```

Query parameters and headers are repeatable:

```bash
./cli --env-file sandbox.env request GET /v1/payments --query limit=20 --query page=1
```

## Validation

```bash
bun run typecheck
bun run test
bun run check
```
