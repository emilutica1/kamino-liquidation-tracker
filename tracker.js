// Kamino Lend liquidation tracker — read-only, holds no keys, signs and sends nothing.
//
// Subscribes to Kamino Lend program logs, picks out transactions that contain a liquidation instruction, fetches
// each one and appends a JSON line to data/liquidations.jsonl: who liquidated, which obligation and market, fees,
// priority fee, Jito tip, flash-loan / Jupiter use, compute units, and the liquidator's token balance changes.
//
// Run:   node tracker.js            (config via environment, see .env.example)
// Check: node tracker.js --check <signature>   decode one past liquidation transaction, print it, exit
// Stop:  Ctrl+C, or kill the PID in data/tracker.pid
'use strict';
const fs = require('fs');
const path = require('path');
const { Connection, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58').default ?? require('bs58');

const CHECK = process.argv.indexOf('--check') > 0 ? process.argv[process.argv.indexOf('--check') + 1] : null;
const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
fs.mkdirSync(DIR, { recursive: true });
const OUT = path.join(DIR, 'liquidations.jsonl');
const PID_FILE = path.join(DIR, 'tracker.pid');
if (!CHECK) fs.writeFileSync(PID_FILE, String(process.pid));

// Defaults are keyless public endpoints. Fetch retries rotate through RPC_HTTP (comma-separated list allowed).
const HTTPS = (process.env.RPC_HTTP || 'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com').split(',').map((s) => s.trim()).filter(Boolean);
const WS = process.env.RPC_WS || 'wss://api.mainnet-beta.solana.com';
const FETCH_GAP_MS = Number(process.env.FETCH_GAP_MS || 600);   // pause between fetches, keeps public RPC happy

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const LIQ_LOG = /Instruction: LiquidateObligationAndRedeemReserveCollateral(V2)?\b/;
// Anchor discriminators of the two liquidation instructions (v1, v2)
const LIQ_DISCS = new Set(['a2a1238f1ebbb967', 'b1479abce2854a37']);
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SCOPE = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
// The 8 official Jito tip accounts (https://docs.jito.wtf)
const JITO_TIPS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL', '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let conn;
let subId = null;
let lastNotificationMs = Date.now();
const stats = { notifications: 0, liquidationSigs: 0, recorded: 0, fetchFailed: 0, reconnects: 0 };
const queue = [];
const seen = new Set();

// On start (tracking mode only), re-queue signatures that were recorded as fetchFailed and never fetched since.
if (!CHECK) try {
  const lines = fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const ok = new Set(lines.filter((x) => !x.fetchFailed).map((x) => x.signature));
  const retry = [...new Map(lines.filter((x) => x.fetchFailed && !ok.has(x.signature)).map((x) => [x.signature, x])).values()];
  for (const x of retry) queue.push({ signature: x.signature, seenAt: x.seenAt, backfill: true });
  if (retry.length) log(`backfill: re-queued ${retry.length} fetch-failed signature(s)`);
} catch { /* no file yet */ }

function subscribe() {
  conn = new Connection(HTTPS[0], { wsEndpoint: WS, commitment: 'confirmed' });
  subId = conn.onLogs(KLEND, (ev) => {
    lastNotificationMs = Date.now();
    stats.notifications++;
    if (stats.notifications === 1) log('receiving Kamino program logs');
    if (ev.err) return;
    if (!ev.logs.some((l) => LIQ_LOG.test(l))) return;
    if (seen.has(ev.signature)) return;
    seen.add(ev.signature);
    if (seen.size > 50_000) seen.clear();
    stats.liquidationSigs++;
    queue.push({ signature: ev.signature, seenAt: Date.now(), liqIxs: ev.logs.filter((l) => LIQ_LOG.test(l)).length });
  }, 'confirmed');
  log('subscribed to Kamino Lend program logs');
}

// Raw JSON-RPC: many liquidators send v1 transactions, so maxSupportedTransactionVersion must be 1.
async function fetchTx(signature) {
  for (let a = 0; a < 6; a++) {
    try {
      const r = await (await fetch(HTTPS[a % HTTPS.length], { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction',
          params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }] }) })).json();
      if (r.result) return r.result;
    } catch (_) { /* rate limit / transient */ }
    await sleep(2000 * (a + 1));
  }
  return null;
}

function describe(item, tx) {
  const msg = tx.transaction.message;   // JSON encoding: accountKeys are strings, instruction data is base58
  const keys = [
    ...msg.accountKeys.map(String),
    ...((tx.meta.loadedAddresses && tx.meta.loadedAddresses.writable) || []).map(String),
    ...((tx.meta.loadedAddresses && tx.meta.loadedAddresses.readonly) || []).map(String),
  ];
  const signer = keys[0];
  let tipLamports = 0;
  keys.forEach((k, i) => { if (JITO_TIPS.has(k) && i < tx.meta.postBalances.length) tipLamports += Math.max(0, tx.meta.postBalances[i] - tx.meta.preBalances[i]); });
  let cuPrice = 0, cuLimit = null;
  for (const ix of msg.instructions) {
    if (keys[ix.programIdIndex] !== COMPUTE_BUDGET) continue;
    const d = Buffer.from(bs58.decode(ix.data));
    if (d[0] === 3 && d.length >= 9) cuPrice = Number(d.readBigUInt64LE(1));
    if (d[0] === 2 && d.length >= 5) cuLimit = d.readUInt32LE(1);
  }
  // v1 transactions: compute limit and priority fee (in lamports) live in the message config
  const v1cfg = msg.transactionConfig || null;
  if (v1cfg && v1cfg.computeUnitLimit != null) cuLimit = v1cfg.computeUnitLimit;
  const programs = [...new Set(msg.instructions.map((ix) => keys[ix.programIdIndex]))];
  // liquidation ix accounts: [liquidator, obligation, lending_market, ...]
  const isLiq = (ix) => keys[ix.programIdIndex] === KLEND.toBase58()
    && LIQ_DISCS.has(Buffer.from(bs58.decode(ix.data)).subarray(0, 8).toString('hex'));
  // top-level first; else inside a wrapper program's CPI
  let liqIx = msg.instructions.find(isLiq), viaProgram = null;
  if (!liqIx) for (const group of (tx.meta.innerInstructions || [])) {
    const inner = group.instructions.find(isLiq);
    if (inner) { liqIx = inner; viaProgram = keys[msg.instructions[group.index].programIdIndex]; break; }
  }
  // liquidator's token balance changes by mint (positive = received)
  const deltas = {};
  const bal = (arr, sign) => (arr || []).forEach((b) => {
    if (b.owner !== signer) return;
    deltas[b.mint] = (deltas[b.mint] || 0) + sign * Number(b.uiTokenAmount.uiAmount || 0);
  });
  bal(tx.meta.postTokenBalances, +1);
  bal(tx.meta.preTokenBalances, -1);
  Object.keys(deltas).forEach((m) => { if (Math.abs(deltas[m]) < 1e-12) delete deltas[m]; });
  const logs = tx.meta.logMessages || [];
  return {
    signature: item.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    seenLagMs: tx.blockTime && item.seenAt ? item.seenAt - tx.blockTime * 1000 : null,
    signer,
    obligation: liqIx ? keys[liqIx.accounts[1]] : null,
    market: liqIx ? keys[liqIx.accounts[2]] : null,
    viaProgram,
    scopeRefresh: programs.includes(SCOPE),
    liqIxs: item.liqIxs,
    feeLamports: tx.meta.fee,
    tipLamports,
    txVersion: tx.version,
    cuPrice,
    v1PriorityFeeLamports: v1cfg ? (v1cfg.priorityFee ?? null) : null,
    cuLimit,
    cuConsumed: tx.meta.computeUnitsConsumed ?? null,
    flashLoan: logs.some((l) => /FlashBorrowReserveLiquidity/.test(l)),
    jupiter: programs.includes(JUPITER),
    programs: programs.length,
    signerTokenDeltas: deltas,
  };
}

async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) { await sleep(1000); continue; }
    await sleep(FETCH_GAP_MS);
    const tx = await fetchTx(item.signature);
    if (!tx) {
      stats.fetchFailed++;
      fs.appendFileSync(OUT, JSON.stringify({ signature: item.signature, seenAt: item.seenAt, fetchFailed: true }) + '\n');
      continue;
    }
    if (item.liqIxs === undefined) item.liqIxs = (tx.meta?.logMessages ?? []).filter((l) => LIQ_LOG.test(l)).length;
    try {
      const rec = describe(item, tx);
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      stats.recorded++;
      log(`liquidation ${rec.signature.slice(0, 12)}… by ${rec.signer.slice(0, 8)}… obligation ${String(rec.obligation).slice(0, 8)}… seen +${rec.seenLagMs} ms`);
    } catch (e) {
      log('describe failed', item.signature, e.message);
    }
  }
}

if (CHECK) {
  fetchTx(CHECK).then((tx) => {
    if (!tx) { console.error('transaction not found'); process.exit(1); }
    console.log(JSON.stringify(describe({ signature: CHECK, seenAt: null }, tx), null, 2));
    process.exit(0);
  });
} else {
  startTracking();
}

function startTracking() {
  // WebSocket watchdog: Kamino emits logs constantly, so 5 minutes of silence means the subscription is dead.
  setInterval(async () => {
    if (Date.now() - lastNotificationMs > 5 * 60_000) {
      stats.reconnects++;
      log('no notifications for 5 min — resubscribing');
      try { if (subId !== null) await conn.removeOnLogsListener(subId); } catch (_) {}
      lastNotificationMs = Date.now();
      subscribe();
    }
  }, 60_000);
  setInterval(() => log('heartbeat', JSON.stringify({ ...stats, queue: queue.length, rssMB: Math.round(process.memoryUsage().rss / 1048576) })), 10 * 60_000);

  const bye = (sig) => { log(`${sig} — exiting`); try { fs.unlinkSync(PID_FILE); } catch (_) {} process.exit(0); };
  process.on('SIGTERM', () => bye('SIGTERM'));
  process.on('SIGINT', () => bye('SIGINT'));
  process.on('uncaughtException', (e) => log('uncaughtException', e && e.message));
  process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));

  subscribe();
  worker();
  log(`started pid=${process.pid}; writing ${OUT}`);
}
