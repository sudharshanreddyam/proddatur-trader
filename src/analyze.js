#!/usr/bin/env node
'use strict';
// Reads data/messages.jsonl (written by fetch.js), parses the options alerts,
// and measures how the signals did using the follow-up posts in the channel:
//   +X% milestone posts, -X% drawdown posts and EOD posts.
// Like prime-intra's board, one row = one contract (ticker + strike + call/put) per trading day.
//
//   node src/analyze.js
//   node src/analyze.js --file data/messages.jsonl --out reports

const fs = require('node:fs');
const path = require('node:path');
const { parseAlert, parseBradAlert, marketDate } = require('./vendor/alerts');

const ROOT = path.join(__dirname, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const readMessages = (file) =>
  fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

// Run the prime-intra parsers over every message; keep alerts and follow-up posts
function classify(messages) {
  const alerts = [];
  const updates = [];
  for (const m of messages) {
    const post = { content: m.content, embeds: m.embeds, createdAt: m.timestamp };
    const p = parseAlert(post) || parseBradAlert(post);
    if (!p) continue;
    const row = { ...p, date: marketDate(m.timestamp), postedAt: m.timestamp, url: m.url };
    if (p.kind === 'update') updates.push(row);
    else alerts.push(row);
  }
  return { alerts, updates };
}

// One row per contract per trading day
function buildContracts({ alerts, updates }) {
  const map = new Map();
  const keyOf = (x) => `${x.date}|${x.ticker}|${x.strike}|${x.right}`;
  const getRow = (x) => {
    const k = keyOf(x);
    if (!map.has(k)) {
      map.set(k, {
        date: x.date, ticker: x.ticker, strike: x.strike, right: x.right,
        expiry: null, signal: null, alertCount: 0, entry: null, alertUrl: null, alertAt: null, updates: [],
      });
    }
    return map.get(k);
  };

  for (const a of alerts) {
    const c = getRow(a);
    c.alertCount++;
    if (!c.alertAt) {
      c.alertAt = a.postedAt;
      c.alertUrl = a.url;
      c.signal = a.signal || 'none';
      c.expiry = a.expiry || null;
    }
    if (c.entry == null && a.entry != null) c.entry = a.entry;
  }
  for (const u of updates) {
    const c = getRow(u);
    c.updates.push(u);
    if (c.entry == null && u.update?.entry != null) c.entry = u.update.entry;
  }

  return [...map.values()].map((c) => {
    c.signal = c.signal || 'unknown';
    c.dte = c.expiry ? Math.round((Date.parse(c.expiry) - Date.parse(c.date)) / 86400000) : null;
    return { ...c, ...outcome(c) };
  });
}

// Measured P&L (%) from the follow-up posts of one contract
function outcome(c) {
  const ups = [...c.updates].sort((a, b) => Date.parse(a.postedAt) - Date.parse(b.postedAt));
  const eodVals = ups.filter((u) => u.update?.kind === 'eod').map((u) => u.update.pnl).filter(Number.isFinite);
  const eod = eodVals.length ? eodVals[eodVals.length - 1] : null;

  const seen = [];
  for (const u of ups) {
    if (u.update?.kind === 'eod') continue;
    if (Number.isFinite(u.update?.pnl)) seen.push(u.update.pnl);
    // "hit +150%" milestone: the threshold itself was reached even if the pnl field is missing
    if (u.update?.kind === 'milestone' && Number.isFinite(u.update.threshold)) seen.push(u.update.threshold);
  }
  const last = seen.length ? seen[seen.length - 1] : null;
  const all = eod != null ? [...seen, eod] : seen;

  const best = all.length ? Math.max(...all) : null;
  const worst = all.length ? Math.min(...all) : null;
  const final = eod ?? last;
  return {
    best,
    worst,
    final,
    finalSource: eod != null ? 'EOD post' : last != null ? 'last update' : null,
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const share = (n, d) => (d ? n / d : null);

function summarize(rows) {
  const withData = rows.filter((r) => r.best != null);
  const scored = rows.filter((r) => r.final != null);
  return {
    contracts: rows.length,
    withFollowUps: withData.length,
    scored: scored.length,
    winRate: share(scored.filter((r) => r.final > 0).length, scored.length),
    medianFinal: median(scored.map((r) => r.final)),
    meanFinal: mean(scored.map((r) => r.final)),
    hitUp50: share(withData.filter((r) => r.best >= 50).length, withData.length),
    hitUp100: share(withData.filter((r) => r.best >= 100).length, withData.length),
    hitDown50: share(withData.filter((r) => r.worst <= -50).length, withData.length),
  };
}

function groupBy(rows, keyFn) {
  const groups = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([k, rs]) => ({ key: k, ...summarize(rs) }));
}

const pct = (x, d = 0) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const pnl = (x) => (x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`);

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function statRows(groups) {
  return groups
    .sort((a, b) => b.contracts - a.contracts)
    .map((g) => [g.key, g.contracts, g.scored, pct(g.winRate), pnl(g.medianFinal), pnl(g.meanFinal),
      pct(g.hitUp50), pct(g.hitUp100), pct(g.hitDown50)]);
}

const STAT_HEADERS = ['Group', 'Contracts', 'Scored', 'Win rate', 'Median final', 'Mean final',
  'Hit +50%', 'Hit +100%', 'Hit −50%'];

function buildReport(rows, meta) {
  const overall = summarize(rows);
  const bySignal = groupBy(rows, (r) => r.signal);
  const bySide = groupBy(rows, (r) => (r.right === 'CALL' ? 'Calls' : 'Puts'));
  const byDte = groupBy(rows, (r) => (r.dte == null ? 'unknown' : r.dte === 0 ? '0DTE' : `${r.dte}DTE+`));
  const byDay = groupBy(rows, (r) => r.date).sort((a, b) => a.key.localeCompare(b.key));
  const byTicker = groupBy(rows, (r) => r.ticker);

  const md = [
    `# Channel signal report`,
    '',
    `Source: ${meta.source}`,
    `Messages read: ${meta.messages}. Alert posts: ${meta.alerts}. Follow-up posts: ${meta.updates}.`,
    `Period: ${meta.from} to ${meta.to} (${meta.days} trading days).`,
    '',
    '## Overall',
    '',
    table(STAT_HEADERS, statRows([{ key: 'All signals', ...overall }])),
    '',
    'Win rate = share of scored contracts whose final P&L (EOD post, else last follow-up post) is above 0. ' +
      'Hit rates use every contract with a follow-up post. Percentages are option P&L vs the alert entry price.',
    '',
    '## By signal',
    '',
    table(STAT_HEADERS, statRows(bySignal)),
    '',
    '## By side',
    '',
    table(STAT_HEADERS, statRows(bySide)),
    '',
    '## By days to expiry',
    '',
    table(STAT_HEADERS, statRows(byDte)),
    '',
    '## By day',
    '',
    table(STAT_HEADERS, statRows(byDay)),
    '',
    '## Top tickers (by alert count)',
    '',
    table(STAT_HEADERS, statRows(byTicker).slice(0, 15)),
    '',
  ];
  return { md: md.join('\n'), overall, bySignal, byDay };
}

function toCsv(rows) {
  const cols = ['date', 'ticker', 'strike', 'right', 'expiry', 'dte', 'signal', 'alertCount', 'entry',
    'best', 'worst', 'final', 'finalSource', 'alertAt', 'alertUrl'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
}

function main() {
  const file = arg('file', path.join(ROOT, 'data', 'messages.jsonl'));
  const outDir = arg('out', path.join(ROOT, 'reports'));
  if (!fs.existsSync(file)) {
    console.error(`${file} not found. Run: npm run fetch`);
    process.exit(1);
  }
  const messages = readMessages(file);
  const { alerts, updates } = classify(messages);
  const rows = buildContracts({ alerts, updates }).sort((a, b) =>
    a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));

  const days = new Set(rows.map((r) => r.date)).size;
  const meta = {
    source: path.relative(ROOT, file) || file,
    messages: messages.length,
    alerts: alerts.length,
    updates: updates.length,
    from: rows[0]?.date ?? '—',
    to: rows[rows.length - 1]?.date ?? '—',
    days,
  };
  const report = buildReport(rows, meta);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.md'), report.md + '\n');
  fs.writeFileSync(path.join(outDir, 'contracts.csv'), toCsv(rows));
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({ meta, overall: report.overall,
    bySignal: report.bySignal, byDay: report.byDay }, null, 2) + '\n');

  console.log(report.md);
  console.log(`\nWrote ${path.relative(ROOT, outDir)}/summary.md, contracts.csv, summary.json`);
}

if (require.main === module) main();

module.exports = { classify, buildContracts, outcome, summarize };
