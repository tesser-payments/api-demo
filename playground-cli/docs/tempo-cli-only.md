# Tempo CLI-only experiments

`provider-experiments tempo` calls Tempo RPC and Turnkey directly. It does not call Tesser,
update platform balances, or test either Tesser SDK. Network inspection works on
mainnet and Moderato. Preparing, signing, and broadcasting transfers requires
Moderato and explicit disposable wallet addresses.

## Network and token selection

Select `--network mainnet` or `--network moderato`. A staging Tesser URL does not select a Tempo network.
Every command reads `eth_chainId` and rejects an RPC connected to another chain.

Mainnet chain ID: `4217`.

USDC mapping: **USDC.e**, six decimals.

[USDC.e contract](https://explore.tempo.xyz/address/0x20C000000000000000000000b9537d11c60E8b50)

USDT mapping: **USDT0**, six decimals.

[USDT0 contract](https://explore.tempo.xyz/address/0x20C00000000000000000000014f22CA97301EB73)

Moderato chain ID: `42431`.

USDC test fixture: **AlphaUSD**, six decimals.

[AlphaUSD contract](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000000000000000000001)

USDT test fixture: **BetaUSD**, six decimals.

[BetaUSD contract](https://explore.testnet.tempo.xyz/address/0x20c0000000000000000000000000000000000002)

The Moderato fixtures do not establish production USDC/USDT support. `inspect`
and `balances` display metadata read from the selected contracts. Use
`--currency USDC|USDT --token-address <address>` to try another six-decimal USD
TIP-20 contract without changing the registry. Preparation records that exact
contract and its metadata; existing files retain their original token identity.

Environment configuration:

```dotenv
TEMPO_MAINNET_RPC_URL=
TEMPO_MODERATO_RPC_URL=
TEMPO_TURNKEY_PUBLIC_KEY=
TEMPO_TURNKEY_PRIVATE_KEY=
TEMPO_TURNKEY_ORGANIZATION_ID=
TEMPO_SPONSOR_PRIVATE_KEY=
```

Empty RPC settings use the public Tempo endpoints. RPC URLs are never printed,
including in verbose errors. Reading and preparing need no Turnkey credentials.
Signing uses the dedicated `TEMPO_TURNKEY_*` settings and the prepared source
address as `signWith`. It does not fall back to the existing Tesser signing keys.
Sponsored preparation and signing also require `TEMPO_SPONSOR_PRIVATE_KEY`, a
`0x`-prefixed 32-byte EVM private key. Only its public address is saved in artifacts.

## Commands

| Command | Effect |
| --- | --- |
| `inspect` | Reads the chain ID and configured token metadata. |
| `balances --address <address>` | Reads both mapped token balances at one block. |
| `prepare` | Reads metadata and the customer nonce; saves an unsigned transfer. `--sponsored` selects AlphaUSD sponsorship and defaults to 1,000,000 gas. |
| `sign` | Requests a Turnkey signature, adds the sponsor signature when selected, and saves the verified signed transaction. |
| `broadcast` | Saves a balance baseline and hash, then submits the signed transaction once. |
| `receipt --hash <hash>` | Reads receipt, token movements, fee evidence, and historical balances. |
| `receipt --record <path>` | Also compares the receipt with the intended transfer and saved baseline. |

`./cli provider-experiments tempo` opens the interactive menu. With `--non-interactive`, supply
all required inputs. Interactive signing and broadcasting show the transfer and
ask for confirmation. An explicit noninteractive sign or broadcast command runs
without a prompt, following the existing CLI convention.

Read-only examples:

```bash
./cli --non-interactive provider-experiments tempo --network mainnet inspect
./cli --non-interactive --output json provider-experiments tempo --network moderato inspect
./cli --non-interactive provider-experiments tempo --network moderato balances --address "$TEMPO_TEST_SOURCE"
```

After choosing and funding disposable test accounts, prepare an experiment.
`TEMPO_TEST_SOURCE` and `TEMPO_TEST_DESTINATION` below are shell placeholders for
those choices, not account defaults configured by the CLI.

```bash
mkdir -p tempo-artifacts
./cli --non-interactive provider-experiments tempo --network moderato prepare \
  --from "$TEMPO_TEST_SOURCE" \
  --to "$TEMPO_TEST_DESTINATION" \
  --currency USDC \
  --amount 1 \
  --format tempo \
  --fee-token 0x20c0000000000000000000000000000000000000 \
  --out tempo-artifacts/alpha-prepared.json
```

This example requests sender-paid fees in pathUSD. That is an experiment input;
it does not set Tesser's production fee policy. For EIP-1559 comparison, select
`--format eip1559` and omit `--fee-token`. EIP-1559 fee selection follows account
preferences and the chain's fallback rules; the receipt supplies actual evidence.

Preparation uses the ordinary account nonce (`nonceKey = 0` for native Tempo),
one TIP-20 `transfer` call, an RPC gas estimate plus 20%, and a maximum gas price
of twice `eth_gasPrice` plus `eth_maxPriorityFeePerGas`. The file records the
resolved values. Override them with `--gas-limit`, `--max-fee-per-gas`, and
`--max-priority-fee-per-gas` for a controlled comparison. Prices are integer USD
units at 18 decimal places; token amounts use the contract's six decimals.
`--gas-limit` also permits preparing a failure experiment that estimation would
otherwise reject, such as insufficient fee funds.

Sign and broadcast are separate commands:

```bash
./cli --env-file config.tempo-test.env --non-interactive provider-experiments tempo --network moderato sign \
  --file tempo-artifacts/alpha-prepared.json \
  --turnkey-type TRANSACTION_TYPE_TEMPO \
  --out tempo-artifacts/alpha-signed.json

./cli --non-interactive provider-experiments tempo --network moderato broadcast \
  --file tempo-artifacts/alpha-signed.json \
  --record tempo-artifacts/alpha-broadcast.json

./cli --non-interactive --output json provider-experiments tempo --network moderato receipt \
  --record tempo-artifacts/alpha-broadcast.json
```

The Turnkey type is an explicit input: `TRANSACTION_TYPE_TEMPO` or
`TRANSACTION_TYPE_ETHEREUM`. This permits comparing the provider's behavior with
each serialization. Sponsored transfers require `TRANSACTION_TYPE_TEMPO`.
These experiments support ordinary secp256k1 EVM accounts; access keys and
multisig are outside this flow.

The CLI validates the unsigned transaction against its recorded fields and
checks the returned signature, sender, exact bytes, and hash. A changed recipient,
amount, token, fee, chain, or transaction format prevents broadcasting.
For native Tempo secp256k1 signatures, it accepts the equivalent recovery-byte
encodings `0/1` and `27/28`. Sender-paid transfers preserve the returned signed
bytes and compute the transaction hash using Tempo's canonical `27/28` encoding.
Sponsored transfers normalize the customer signature before adding the sponsor
signature, then save and broadcast the same final bytes. Every other byte must
match the serialized transaction, and the signature must recover the source.

Files are created with mode `0600` and never overwritten. Signed bytes and stamps
are omitted from terminal output, including verbose mode. The ignored
`tempo-artifacts/` directory keeps local evidence out of version control.

## Sponsored Moderato transfers

1. Fill `TEMPO_SPONSOR_PRIVATE_KEY` in the selected environment file. Preparation
   derives its public address and builds a native Tempo transfer with sponsorship
   enabled, a blank sender fee-token field, and the ordinary customer nonce.
   - A missing or invalid key stops preparation with a configuration error that
     omits the key. Sponsorship supports Moderato USDC (AlphaUSD), with AlphaUSD
     also paying the fee. The sponsor must differ from the customer wallet.
   - The default gas limit is `1000000` to allow for Tempo's first-use account
     and token storage costs; `--gas-limit` overrides it. Sponsorship
     does not simulate the transfer or check sponsor funds before signing.

2. Run `sign` with the prepared file. Turnkey signs the customer payload, then
   the CLI verifies the approved fields and customer signature, sets AlphaUSD
   as the fee token, and signs locally with the sponsor. It verifies both
   signatures before saving the final transaction bytes and hash.
   - A changed sponsor key or altered customer transaction stops signing.
     Neither signing operation broadcasts the transfer.
   - A pending Turnkey activity uses the existing `--activity-id` resume flow.
     Sponsorship happens only after Turnkey returns a completed signature.

3. Run `broadcast`, then `receipt --record`. The broadcast record captures
   customer, recipient, and sponsor balances before submission. Receipt output
   verifies the intended payer and AlphaUSD fee token and reports the sponsor's
   debit minus refund as `fee_evidence.sponsor_fee.net_fee`.
   - An unfunded sponsor reaches the node and is rejected there. The CLI does
     not switch to sender-paid fees or submit another transaction. Reusing a
     broadcast record observes the existing hash without submitting again.
   - A revert still reports any verified sponsor fee and returns a nonzero
     exit code. Missing or inconsistent fee evidence reports
     `sponsorship_verified: false` and also returns a nonzero exit code.
   - Balance differences include other transactions between the snapshot
     blocks. Isolate these test wallets when checking that the customer spent
     only the transfer amount and the sponsor spent only the fee.

With a funded sponsor and selected disposable source and recipient:

```bash
./cli --env-file config.tempo-test.env --non-interactive provider-experiments tempo --network moderato prepare \
  --from "$TEMPO_TEST_SOURCE" \
  --to "$TEMPO_TEST_DESTINATION" \
  --currency USDC --amount 1 --format tempo --sponsored \
  --out tempo-artifacts/sponsored-prepared.json

./cli --env-file config.tempo-test.env --non-interactive provider-experiments tempo --network moderato sign \
  --file tempo-artifacts/sponsored-prepared.json \
  --turnkey-type TRANSACTION_TYPE_TEMPO \
  --out tempo-artifacts/sponsored-signed.json

./cli --env-file config.tempo-test.env --non-interactive provider-experiments tempo --network moderato broadcast \
  --file tempo-artifacts/sponsored-signed.json \
  --record tempo-artifacts/sponsored-broadcast.json

./cli --env-file config.tempo-test.env --non-interactive --output json provider-experiments tempo --network moderato receipt \
  --record tempo-artifacts/sponsored-broadcast.json
```

For the successful experiment, give the customer exactly the transfer amount in
AlphaUSD and fund the separate sponsor with AlphaUSD for fees. Verify the
customer decreases by the transfer amount, the recipient increases by that
amount, and the sponsor decreases by the verified net fee. This exercises the
Turnkey and Tempo mechanism directly; Tesser API accounting and SDK acceptance
remain separate work.

## Resume and evidence

A pending Turnkey activity prints its ID. Repeat `sign` with the same prepared
file, type, and output path plus `--activity-id <id>` to query that activity.
This does not request another signature. If the signing request itself times out,
look up the activity in Turnkey before deciding whether to retry.

Broadcast creates its record before calling `eth_sendRawTransaction`. If the RPC
times out, that file still contains the expected hash and before balances. Reusing
the same `--record` with `broadcast` only observes the hash; it never submits again.
A record means an attempt was about to be made, not that the chain accepted it.

`receipt` performs one observation. Repeat it while the status is
`not_mined_or_not_found`. A successful receipt verifies the intended transfer only
when its token, sender, recipient, and exact amount match the saved intent. A
redirected or missing transfer is reported as unverified. Reverts and failed
intent checks return a nonzero exit code.

Output includes the explorer link, receipt status, block hash, observed
confirmations, token metadata, every decoded Transfer event, raw receipt logs,
gas data, and movements involving the fee manager. Debits and refunds remain
separate. Missing fee-transfer events do not mean the fee was zero.

With a record, balance changes use the saved baseline and the receipt block.
Without one, they compare the preceding block with the receipt block. Other
transactions in those blocks may affect the differences. Historical RPC failures
are reported as unavailable balances while preserving the receipt evidence.
These observations do not establish backend accounting or a finality policy.

## Validation boundary

Run `bun run check` for typechecking and the CLI test suite. The Tempo tests use
local fixture keys and mocked RPC/Turnkey responses. Public chain and token reads
can verify configuration without selecting any test accounts. A live test also
verifies Turnkey acceptance, broadcast, and fee behavior for its selected accounts.

On September 16, 2026, a sponsored 3 AlphaUSD transfer passed on Moderato (42431):
[transaction 0x43b5e9943393224d9d1fa074f46e587247d70dd4a0eed144c094c1d49e765861](https://explore.testnet.tempo.xyz/tx/0x43b5e9943393224d9d1fa074f46e587247d70dd4a0eed144c094c1d49e765861).
The sender `0xa453549C4d75A68f53d2483002884E9b2e63D9B4` spent its exact 3 AlphaUSD
balance and ended at zero. Recipient `0x2b89795A07128Ac2055D21A3a4351C71EeE5849c`
gained 3 AlphaUSD. Sponsor `0x11f54044793bb09341ca8a314ABE6e38E807D05f` paid
0.000507 AlphaUSD, verified against its balance change and the receipt fee events.
The transaction used 290,842 gas. The platform sponsor helper reproduced the same
signed bytes from the completed Turnkey activity.

The first attempt exposed an insufficient 100,000 gas default for a first-use
Tempo wallet. The node rejected it without advancing the sender nonce. The
corrected default is 1,000,000 gas; the transfer succeeded with fresh signatures.
The CLI passed type checking and all 124 tests after this correction. This direct
test leaves Tesser API accounting, both SDKs and mainnet acceptance pending.

On September 7, 2026, the implemented `inspect` command passed against the public
mainnet RPC at block `38454538` and Moderato RPC at block `34294907`, returning the
chain IDs and token identities above. No wallet accounts or live signing calls
were used for that check.

Provider references:

[Tempo connection details](https://docs.tempo.xyz/quickstart/connection-details)

[Tempo testnet faucet](https://docs.tempo.xyz/quickstart/faucet)

[Tempo transaction format](https://docs.tempo.xyz/protocol/transactions/spec-tempo-transaction)

[Tempo fee specification](https://docs.tempo.xyz/protocol/fees/spec-fee)

[Turnkey sign transaction API](https://docs.turnkey.com/api-reference/activities/sign-transaction)
