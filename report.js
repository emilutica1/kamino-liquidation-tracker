// Summary report over data/liquidations.jsonl (written by tracker.js). Read-only, no network.
// Usage: node report.js [--from 2026-11-01] [--to 2026-11-08] [--file path/to/liquidations.jsonl]
'use strict';
const fs = require('fs');
const path = require('path');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const FILE = arg('file') || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'liquidations.jsonl');
const from = arg('from') ? Date.parse(arg('from')) : 0;
const to = arg('to') ? Date.parse(arg('to')) : Infinity;

const MARKETS = {
  '7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF': 'Main',
  'DxXdAyU3kCjnyggvHmY5nAwg5cRbbmdyX3npfDMjjMek': 'JLP',
  '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua': 'xStocks',
};
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '?');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : '-');
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p90 = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };

let rows;
try {
  rows = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
} catch (e) { console.error(`cannot read ${FILE}: ${e.message}`); process.exit(1); }
const failed = rows.filter((r) => r && r.fetchFailed).length;
const recs = rows.filter((r) => r && r.blockTime && r.blockTime * 1000 >= from && r.blockTime * 1000 <= to);
if (!recs.length) { console.log('no liquidations in range'); process.exit(0); }

const t = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
console.log(`Kamino liquidations: ${recs.length}  (${t(recs[0].blockTime)} → ${t(recs[recs.length - 1].blockTime)} UTC; fetch-failed lines in file: ${failed})\n`);

const count = (key) => { const m = new Map(); for (const r of recs) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };

console.log('By day (UTC)');
for (const [d, n] of count((r) => new Date(r.blockTime * 1000).toISOString().slice(0, 10)).sort()) console.log(`  ${d}  ${String(n).padStart(5)}`);

console.log('\nBy market');
for (const [m, n] of count((r) => r.market)) console.log(`  ${(MARKETS[m] || short(m)).padEnd(12)} ${String(n).padStart(5)}  ${pct(n, recs.length)}`);

const liqs = count((r) => r.signer);
console.log(`\nLiquidators: ${liqs.length} distinct wallets; top 10`);
for (const [s, n] of liqs.slice(0, 10)) console.log(`  ${short(s)}  ${String(n).padStart(5)}  ${pct(n, recs.length)}`);

const tips = recs.map((r) => r.tipLamports || 0);
const prio = recs.map((r) => (r.v1PriorityFeeLamports != null ? r.v1PriorityFeeLamports : Math.round(((r.cuPrice || 0) * (r.cuLimit || 200_000)) / 1e6)));
const lag = recs.map((r) => r.seenLagMs).filter((x) => x != null);
console.log('\nHow they do it');
console.log(`  Jito tip paid:          ${pct(tips.filter((x) => x > 0).length, recs.length)}  (median tip when paid ${median(tips.filter((x) => x > 0)) ?? '-'} lamports)`);
console.log(`  priority fee (approx.): median ${median(prio)} lamports, p90 ${p90(prio)} lamports`);
console.log(`  flash loan:             ${pct(recs.filter((r) => r.flashLoan).length, recs.length)}`);
console.log(`  Jupiter swap in tx:     ${pct(recs.filter((r) => r.jupiter).length, recs.length)}`);
console.log(`  via wrapper program:    ${pct(recs.filter((r) => r.viaProgram).length, recs.length)}`);
console.log(`  Scope price refresh:    ${pct(recs.filter((r) => r.scopeRefresh).length, recs.length)}`);
console.log(`  v1 transactions:        ${pct(recs.filter((r) => r.txVersion === 1).length, recs.length)}`);
console.log(`  compute units used:     median ${median(recs.map((r) => r.cuConsumed).filter((x) => x != null))}`);
console.log(`\nTracker detection lag (seen − block time): median ${median(lag)} ms, p90 ${p90(lag)} ms  (block time has 1 s resolution)`);
