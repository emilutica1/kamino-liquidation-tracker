# Kamino Liquidation Tracker

A small, real-time, **read-only** tracker for liquidations on [Kamino Lend](https://kamino.finance) (Solana).

It listens to the Kamino Lend program, picks out every liquidation as it happens, and records who did it and how:
which obligation and market, transaction fees, priority fee, Jito tip, flash-loan and Jupiter use, compute units,
transaction version, and the liquidator's token balance changes. A report script turns the log into a summary of the
liquidation market: volume per day and market, the active liquidators, and the techniques they use.

It holds no keys, signs nothing and sends nothing. It works on free public RPC endpoints out of the box.

## Why

Liquidations keep lending protocols solvent, but the market for them is opaque: who is doing them, how concentrated
the competition is, and what it takes to land one (tips, priority fees, flash loans, price-oracle refreshes).
This tool makes that visible from public on-chain data, for researchers, risk teams, protocol teams and anyone
evaluating whether to build a liquidator.

## Example: one month of real data

Recorded continuously from 2026-10-05 to 2026-11-06 (`node report.js`):

| | |
|---|---|
| Liquidations recorded | 1,763 |
| Distinct liquidator wallets | 69 |
| Share of the two largest liquidators | 20.6% and 18.2% |
| Main market / JLP market / xStocks market | 84.5% / 6.1% / 2.9% |
| Used a flash loan | 60.1% |
| Refreshed Scope prices in the same transaction | 68.6% |
| Paid a Jito tip | 32.7% (median 268,342 lamports when paid) |
| v1 transactions | 66.8% |
| Swapped through Jupiter in the same transaction | 25.4% |
| Tracker detection lag (public WebSocket) | median 743 ms, p90 1,205 ms after block time |

Liquidations come in bursts: most days see a handful, while sharp price moves produce 100–280 in a day.

## Quick start

Requires Node.js 18 or newer.

```bash
git clone <this repo>
cd kamino-liquidation-tracker
npm install
node tracker.js          # runs until stopped (Ctrl+C); appends to data/liquidations.jsonl
node report.js           # summary of everything recorded so far
```

Run it in the background:

```bash
nohup node tracker.js >> data/tracker.log 2>&1 &
kill $(cat data/tracker.pid)   # stop
```

Decode a single past liquidation transaction without starting the tracker:

```bash
node tracker.js --check <transaction signature>
```

Report for a date range:

```bash
node report.js --from 2026-11-01 --to 2026-11-08
```

## Configuration

Everything is optional; set environment variables (see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `RPC_HTTP` | `https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com` | HTTP endpoints for `getTransaction`; retries rotate through the list |
| `RPC_WS` | `wss://api.mainnet-beta.solana.com` | WebSocket endpoint for the program-log subscription |
| `DATA_DIR` | `./data` | Where `liquidations.jsonl` and the PID file are written |
| `FETCH_GAP_MS` | `600` | Pause between transaction fetches; raise it if a public RPC rate-limits you |

A private RPC endpoint lowers the detection lag and avoids rate limits during liquidation bursts.

## How it works

1. **Subscribe** to Kamino Lend (`KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD`) program logs at `confirmed` commitment and
   keep successful transactions whose logs contain `LiquidateObligationAndRedeemReserveCollateral(V2)`.
2. **Fetch** each transaction with `maxSupportedTransactionVersion: 1` (many liquidators already send v1 transactions,
   which older clients cannot read).
3. **Decode** the liquidation instruction by its discriminator, top level or inside a wrapper program's inner
   instructions, to get the obligation and market; read compute-budget settings (legacy instructions or the v1 message
   config), Jito tips (balance changes of the 8 official tip accounts) and the liquidator's token balance changes.
4. **Append** one JSON line per liquidation. If a fetch fails after retries, a `fetchFailed` line is written and the
   signature is retried automatically on the next start.

A watchdog re-subscribes if the WebSocket goes silent for 5 minutes, and a heartbeat line is logged every 10 minutes.

## Record format

```json
{
  "signature": "3GGrQFEi…",
  "slot": 466155689,
  "blockTime": 1793977992,
  "seenLagMs": 509,
  "signer": "LionX7R6…",
  "obligation": "GQSVF5Xo…",
  "market": "5wJeMrUY…",
  "viaProgram": null,
  "scopeRefresh": true,
  "liqIxs": 1,
  "feeLamports": 28428,
  "tipLamports": 0,
  "txVersion": 1,
  "cuPrice": 0,
  "v1PriorityFeeLamports": 23428,
  "cuLimit": 694337,
  "cuConsumed": 427448,
  "flashLoan": true,
  "jupiter": false,
  "programs": 4,
  "signerTokenDeltas": { "<mint>": 0.00041422 }
}
```

| Field | Meaning |
|---|---|
| `seenLagMs` | When the tracker saw the transaction minus its block time (block time has 1-second resolution) |
| `signer` | Fee payer, i.e. the liquidator |
| `viaProgram` | Wrapper program that called Kamino, if the liquidation was not a top-level instruction |
| `scopeRefresh` | The transaction also refreshed Kamino's Scope price oracle |
| `liqIxs` | Number of liquidation instructions in the transaction |
| `tipLamports` | Total paid to Jito tip accounts |
| `cuPrice` / `cuLimit` | Legacy compute-budget priority fee (micro-lamports per CU) and limit |
| `v1PriorityFeeLamports` | Priority fee of a v1 transaction (lamports) |
| `signerTokenDeltas` | Liquidator's token balance changes by mint, positive = received |

## Limitations

- Only successful liquidations are recorded; failed attempts by other bots are not.
- Token deltas are raw token amounts, not USD values.
- Public endpoints can drop or rate-limit; the tracker retries and backfills, but a dedicated RPC is more reliable.

## License

MIT
