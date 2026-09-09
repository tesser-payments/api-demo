# Tesser Playground CLI

A standalone Bun and TypeScript playground organized around Tesser API resources, workspace setup, and direct provider experiments.

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

Environment files contain credentials and connection settings only. Operation inputs such as amounts, account IDs, currencies, networks, polling intervals, and workflow timeouts use command options or interactive prompts.

Calling-process environment takes precedence over the selected env file. Non-secret connection settings use built-in defaults where possible.

Each operation validates its local prerequisites before prompting or making an API request. Missing variables are reported together. Required groups are:

- Tesser operations: `TESSER_BASE_URL`, `TESSER_AUTH_URL`, `TESSER_CLIENT_ID`, and `TESSER_CLIENT_SECRET`
- Wallet-signing operations: the Tesser variables plus `SIGNING_PUBLIC_KEY`, `SIGNING_PRIVATE_KEY`, and `SIGNING_ENCLAVE_ID`
- Admin invitations: `TESSER_BASE_URL` and `ADMIN_API_SECRET`
- Direct Kraken operations: `KRAKEN_API_KEY` and `KRAKEN_API_SECRET`
- Tempo signing: `TEMPO_TURNKEY_PUBLIC_KEY`, `TEMPO_TURNKEY_PRIVATE_KEY`, and `TEMPO_TURNKEY_ORGANIZATION_ID`

The CLI exits after a successful, cancelled, or failed operation. `Back` only navigates to the parent menu.

## Interactive mode

```bash
./cli --env-file sandbox.env
./cli --env-file prod.env workspace invite recipient@example.com
./cli --env-file sandbox.env payment create
./cli --env-file sandbox.env treasury withdrawal --with-ui
./cli --env-file sandbox.env treasury rebalance --with-ui
./cli --env-file staging.env treasury deposit --with-ui
./cli --env-file staging.env workspace register-secrets kraken
./cli --env-file staging.env provider-experiments kraken deposit --with-ui
./cli --env-file staging.env provider-experiments kraken swap --from-currency BRL
./cli --env-file config.staging.env provider-experiments kraken brl-to-usdc --network BASE
./cli --env-file config.staging.env provider-experiments tempo inspect --network moderato
```

With no command, the CLI opens resource-based menus. Explicit commands prompt for missing operation values and confirm mutations.

`workspace invite` creates the Auth0 user and asks Auth0 to email the recipient a
password-setup link. It does not return a copyable invitation link. Configure
`TESSER_BASE_URL` and `ADMIN_API_SECRET` for the selected environment. The command
does not require Tesser Auth0 client credentials.
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

`workspace register-secrets kraken` registers Kraken secrets with Tesser. `treasury deposit`
runs an end-to-end Tesser BRL deposit into Kraken. Direct Kraken operations live under
`provider-experiments kraken`. Deposit diagnostics and withdrawals use Funding Beta;
balances and swaps use Spot REST.
Add `KRAKEN_API_KEY` and `KRAKEN_API_SECRET` to the selected environment file. Enable
Query Funds and Deposit Funds for registration and BRL deposits. Enable Create/Modify
Orders, Query Open Orders, Query Closed Orders, Withdraw Funds, and Add Withdrawal
Addresses for the other direct Kraken workflows.
Set `KRAKEN_BASE_URL` in each environment that needs a different Kraken API endpoint.
An unset or empty value uses `https://api.kraken.com`.

`workspace register-secrets kraken` claims the first CAD method's instructions or reads normalized
instructions from `--cad-instructions-file`, then registers the credentials through
Tesser. `treasury deposit` creates the Tesser BRL plan, verifies the non-payable Staging
instructions, pauses for the real `Pix (PayAmigo)` deposit in Kraken Web, and polls
Tesser until reconciliation completes. Swap validates the market order before asking
for confirmation. Registering a withdrawal address and withdrawing to an existing
address are separate provider operations.

`provider-experiments kraken brl-to-usdc` is a separate experiment that acts as Tesser without calling
the Tesser API. It accepts a destination EVM address, uses a selected or newly observed
BRL deposit at Kraken, executes immediate `BRL1/USD` and `USDC/USD` market orders, and
withdraws the resulting USDC through the matching native Ethereum or Base mainnet method.
The CLI cannot verify that the supplied address belongs to a Tesser-managed wallet. The
address must already be registered and verified manually in Kraken for the selected
network. The command requires live Kraken credentials and explicit confirmation before
each market order and the withdrawal. It keeps fee-quote tokens and full wallet addresses
out of output.
Before requesting new funding, it lists successful deposits and asks whether to reuse
one. Pass `--kraken-deposit-id` to select one directly.
If the BRL-to-USD order completed but a later action failed, pass
`--resume-usd-amount <available-usd>` to continue with the provider's available USD
without selecting the deposit or repeating the first order.

The Tesser BRL deposit, direct Funding API deposit, swap, and withdrawal flows ask
whether to enable a live UI, defaulting to disabled. Pass `--with-ui` to skip the prompt.
Their dashboards are written under `ui/kraken/<command>/index.html` and update while
the CLI polls Kraken or Tesser.

```bash
./cli --env-file staging.env workspace register-secrets kraken
./cli --env-file staging.env treasury deposit --amount 50.00
./cli --env-file config.staging.env provider-experiments kraken brl-to-usdc --network BASE
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
./cli payment create [destination-wallet-address]
./cli payment simulate-inbound
./cli treasury deposit
./cli treasury withdrawal
./cli treasury rebalance
./cli accounts wallet-address
./cli accounts create-bank-account
./cli workspace invite [email]
./cli workspace register-secrets kraken
./cli workspace register-secrets openfx [api-key-file]
./cli workspace openfx-webhook-url
./cli provider-experiments kraken balances
./cli provider-experiments kraken deposit
./cli provider-experiments kraken deposit show [kraken-deposit-id]
./cli provider-experiments kraken swap
./cli provider-experiments kraken register-withdrawal-address
./cli provider-experiments kraken withdraw
./cli provider-experiments kraken brl-to-usdc
./cli provider-experiments tempo inspect
./cli provider-experiments tempo balances
./cli provider-experiments tempo prepare
./cli provider-experiments tempo sign
./cli provider-experiments tempo broadcast
./cli provider-experiments tempo receipt
./cli provider-experiments basis-theory patch-openfx-token
./cli provider-experiments basis-theory delete-token
```

Use `./cli <command> --help` for command options.
The previous top-level command paths remain available as hidden compatibility paths.

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
