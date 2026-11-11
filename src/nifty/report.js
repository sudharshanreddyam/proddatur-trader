'use strict';
// Builds the NIFTY paper-straddle and AVI-F live/dry summaries from parsed events.

const sum = (xs) => xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
const rs = (x) => (x == null ? '—' : `${x >= 0 ? '+' : '−'}₹${Math.abs(Math.round(x)).toLocaleString('en-IN')}`);
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);

const trailBucket = (steps) => {
  if (steps == null) return 'unknown';
  if (steps === 0) return '0 steps';
  if (steps === 1) return '1 step';
  if (steps === 2) return '2 steps';
  return '3+ steps';
};

function table(headers, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function legStats(legs) {
  return {
    n: legs.length,
    wins: legs.filter((l) => l.net > 0).length,
    net: sum(legs.map((l) => l.net)),
  };
}

function buildReport(events) {
  const real = events.filter((e) => !e.synthetic);

  // ---- Paper straddles ----
  const eods = real.filter((e) => e.kind === 'eod_summary').sort((a, b) => a.date.localeCompare(b.date));
  // Leg P&L comes from the EOD summaries, which list every leg of every straddle.
  // "Leg Closed" posts miss some legs and can't tell two straddles apart when both
  // sell the same strike, so they are only used to add trail steps.
  const trailByLeg = new Map();
  for (const l of real.filter((e) => e.kind === 'leg_closed' && e.mode === 'paper')) {
    trailByLeg.set(`${l.strategy}|${l.exitDate}|${l.side}|${l.strike}`, l.trailSteps);
  }
  const legs = eods.flatMap((d) => d.groups.flatMap((g) => g.legs.map((l) => ({
    date: d.date,
    strategy: g.strategy,
    side: l.side,
    strike: l.strike,
    reason: l.reason,
    entry: l.entry,
    exitPx: l.exit,
    net: l.net,
    trailSteps: trailByLeg.get(`${g.strategy}|${d.date}|${l.side}|${l.strike}`) ?? null,
  }))));

  const days = eods.map((d) => ({
    date: d.date,
    basket: d.basketNet,
    legNet: sum(d.groups.flatMap((g) => g.legs.map((l) => l.net))),
  }));
  const dayNets = days.map((d) => d.basket).filter(Number.isFinite);
  const paper = {
    days: days.length,
    green: dayNets.filter((x) => x > 0).length,
    basketNet: sum(dayNets),
    first: days[0]?.date ?? '—',
    last: days[days.length - 1]?.date ?? '—',
    worst: dayNets.length ? Math.min(...dayNets) : null,
    best: dayNets.length ? Math.max(...dayNets) : null,
  };

  const bySide = ['CE', 'PE'].map((side) => ({ side, ...legStats(legs.filter((l) => l.side === side)) }));
  const byReason = ['SL', 'EOD'].map((r) => ({ reason: r, ...legStats(legs.filter((l) => l.reason === r)) }));
  const byTrail = ['0 steps', '1 step', '2 steps', '3+ steps'].map((b) => ({
    bucket: b, ...legStats(legs.filter((l) => trailBucket(l.trailSteps) === b)),
  }));
  const byStrategy = ['S1_0930', 'S2_1030'].map((s) => ({ strategy: s, ...legStats(legs.filter((l) => l.strategy === s)) }));

  // ---- AVI-F ----
  const avi = real.filter((e) => ['live', 'dry'].includes(e.mode));
  const spreads = avi.filter((e) => e.kind === 'spread_opened');
  const stops = avi.filter((e) => e.kind === 'short_leg_stopped');
  const mismatches = avi.filter((e) => e.kind === 'position_mismatch');

  const liveStops = stops.filter((s) => s.mode === 'live');
  const mismatchDays = [...new Set(mismatches.map((m) => `${m.date} (${m.mode})`))];

  // Cumulative basket P&L up to 2026-09-15, to compare with the bot's own "Results Since Deploy"
  const cumulativeTo0915 = sum(days.filter((d) => d.date <= '2026-09-15').map((d) => d.basket));
  const resultsReport = real.filter((e) => e.kind === 'results_report').map((e) => e.body).pop() || null;

  return { paper, bySide, byReason, byTrail, byStrategy, legs, days, spreads, stops, liveStops, mismatches,
    mismatchDays, cumulativeTo0915, resultsReport };
}

function renderMarkdown(r) {
  const p = r.paper;
  const lines = [
    '# NIFTY straddles and AVI-F spreads',
    '',
    '## Paper straddles (simulation only)',
    '',
    `Trading days with an EOD summary: ${p.days} (${p.first} to ${p.last}). Green days: ${p.green}/${p.days}.`,
    `Sum of the bot's daily basket P&L: **${rs(p.basketNet)}**. Best day ${rs(p.best)}, worst day ${rs(p.worst)}.`,
    '',
    `Cumulative basket P&L through 2026-09-15 is ${rs(r.cumulativeTo0915)}. The bot's own "Results Since Deploy" post reports a net figure for the same period, quoted below for comparison.`,
    '',
    'Leg-level stats are from the EOD summaries (all legs, net after costs). Trail steps come from the "Leg Closed" posts where present.',
    '',
    table(['Side', 'Legs', 'Wins', 'Win rate', 'Net P&L'],
      r.bySide.map((s) => [s.side, s.n, s.wins, pct(s.n ? s.wins / s.n : null), rs(s.net)])),
    '',
    table(['Exit reason', 'Legs', 'Wins', 'Win rate', 'Net P&L'],
      r.byReason.map((s) => [s.reason, s.n, s.wins, pct(s.n ? s.wins / s.n : null), rs(s.net)])),
    '',
    `Trail steps come from ${r.byTrail.reduce((a, b) => a + b.n, 0)} of ${r.legs.length} legs. The rest have no "Leg Closed" post in the export.`,
    '',
    table(['Trail steps reached', 'Legs', 'Wins', 'Win rate', 'Net P&L'],
      r.byTrail.map((s) => [s.bucket, s.n, s.wins, pct(s.n ? s.wins / s.n : null), rs(s.net)])),
    '',
    `The bot's "Results Since Deploy" post, as posted:`,
    '',
    '> ' + (r.resultsReport ?? 'none').split('\n').slice(0, 3).join('\n> '),
    '',
    table(['Entry', 'Legs', 'Wins', 'Win rate', 'Net P&L'],
      r.byStrategy.map((s) => [s.strategy, s.n, s.wins, pct(s.n ? s.wins / s.n : null), rs(s.net)])),
    '',
    '## AVI-F spreads',
    '',
  ];

  const liveSpreads = r.spreads.filter((s) => s.mode === 'live');
  const drySpreads = r.spreads.filter((s) => s.mode === 'dry');
  lines.push(`Live spreads opened: ${liveSpreads.length}. Dry-run spreads: ${drySpreads.length}.`);
  lines.push('');
  lines.push(table(['Opened (IST post date)', 'Mode', 'Expiry', 'Short', 'Long', 'Credit', 'Short SL'],
    r.spreads.map((s) => [s.date, s.mode, s.expiry, s.short ? `${s.short.strike} ${s.short.side} @ ${s.short.price}` : '—',
      s.long ? `${s.long.strike} ${s.long.side} @ ${s.long.price}` : '—', rs(s.credit), s.shortSl ?? '—'])));
  lines.push('');

  lines.push(`Short-leg stops: ${r.stops.length}. Realized P&L on those stopped shorts: **${rs(sum(r.stops.map((s) => s.pnl)))}** (live only: ${rs(sum(r.liveStops.map((s) => s.pnl)))}).`);
  lines.push('Long legs are not closed in these posts, so each spread\'s total result is unknown.');
  lines.push('');
  lines.push(table(['Date', 'Mode', 'Contract', 'Entry', 'Exit', 'P&L'],
    r.stops.map((s) => [s.date, s.mode, s.contract, s.entry, s.exitPx, rs(s.pnl)])));
  lines.push('');

  lines.push(`Position mismatch posts: ${r.mismatches.length} on ${r.mismatchDays.length} day-mode groups: ${r.mismatchDays.join(', ') || 'none'}.`);
  lines.push('');
  return lines.join('\n');
}

function legsCsv(r) {
  const cols = ['exitDate', 'exitAt', 'strategy', 'side', 'strike', 'contract', 'reason', 'entry', 'exitPx',
    'trailSteps', 'gross', 'costs', 'net', 'url'];
  const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...r.legs.sort((a, b) => (a.exitAt || '').localeCompare(b.exitAt || ''))
    .map((l) => cols.map((c) => esc(l[c])).join(','))].join('\n') + '\n';
}

module.exports = { buildReport, renderMarkdown, legsCsv };
