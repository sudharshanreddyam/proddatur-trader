'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNiftyMessages, rupees, num } = require('../src/nifty/parse');
const { buildReport } = require('../src/nifty/report');

const msg = (id, ts, title, footer, fields = [], description = null) => ({
  id, timestamp: ts, content: '', url: `u/${id}`,
  embeds: [{ author: null, title, description, fields, footer }],
});

test('rupee and number parsing', () => {
  assert.equal(rupees('Rs 14,349'), 14349);
  assert.equal(rupees('₹-20,361'), -20361);
  assert.equal(rupees('**Rs -3,384**'), -3384);
  assert.equal(num('`24875.40`'), 24875.4);
});

test('straddle entry and leg closed', () => {
  const evs = parseNiftyMessages([
    msg('1', '2026-09-01T04:00:00Z', '⚡  Straddle Entry — Straddle930 (09:30 IST)', 'PAPER · S1_0930', [
      { name: '📈  SELL CE 24900', value: '`NIFTY2690124900CE`\nEntry `118.50`\nSL `177.75`' },
      { name: '📉  SELL PE 24900', value: '`NIFTY2690124900PE`\nEntry `102.25`\nSL `153.38`' },
      { name: '🎯 Spot at entry', value: '`24875.40`' },
      { name: '💰 Credit received', value: '`Rs 14,349`' },
    ]),
    msg('2', '2026-09-01T10:00:00Z', '🛑  Leg Closed — Straddle930 PE', 'PAPER · S1_0930', [
      { name: '📄 Contract', value: '`NIFTY2690124900PE`' },
      { name: '🚪 Reason', value: '`SL`' },
      { name: '🕐 Exit', value: '`2026-09-01 11:42:00`' },
      { name: '🎯 Entry', value: '`102.25`' },
      { name: '🚪 Exit px', value: '`153.38`' },
      { name: '📉 Trail', value: '`0` steps → SL `153.38`' },
      { name: '📊 Net', value: '**Rs -3,384**' },
    ]),
  ]);
  const [entry, leg] = evs;
  assert.equal(entry.kind, 'straddle_entry');
  assert.equal(entry.strategy, 'S1_0930');
  assert.equal(entry.legs[0].contract, 'NIFTY2690124900CE');
  assert.equal(entry.legs[1].sl, 153.38);
  assert.equal(entry.credit, 14349);
  assert.equal(leg.kind, 'leg_closed');
  assert.equal(leg.side, 'PE');
  assert.equal(leg.strike, 24900);
  assert.equal(leg.net, -3384);
  assert.equal(leg.trailSteps, 0);
});

test('EOD summary reconciles with its legs', () => {
  const [eod] = parseNiftyMessages([
    msg('3', '2026-09-01T10:10:00Z', '📊  Straddle Paper — EOD Summary  2026-09-01', 'PAPER — no real orders were placed', [
      { name: '🔴 Straddle930  — Rs -1,267', value: '`CE 24900`  118.50 → 85.00  (EOD)  **Rs 2,117**\n`PE 24900`  102.25 → 153.38  (SL)  **Rs -3,384**' },
      { name: '🧺 Basket net', value: '**Rs -1,267**' },
    ]),
  ]);
  assert.equal(eod.kind, 'eod_summary');
  assert.equal(eod.basketNet, -1267);
  assert.equal(eod.groups[0].strategy, 'S1_0930');
  assert.deepEqual(eod.groups[0].legs.map((l) => l.net), [2117, -3384]);
});

test('AVI-F live and dry posts', () => {
  const evs = parseNiftyMessages([
    msg('4', '2026-10-28T10:00:00Z', '🔴 LIVE · AVI-F — Spread Opened', 'NRML · fills are broker average_price', [
      { name: 'Spot', value: '22,554.8' },
      { name: 'Expiry', value: '2026-11-03' },
      { name: 'Qty', value: '1 lot (65)' },
      { name: 'SELL', value: '22550 CE @ ₹205.55' },
      { name: 'BUY', value: '22850 CE @ ₹88.35' },
      { name: 'Net credit', value: '₹7,618' },
      { name: 'Short SL (150%)', value: '₹513.88' },
    ]),
    msg('5', '2026-10-30T06:19:00Z', '🔴 LIVE · AVI-F — Short Leg Stopped', 'NRML', [],
      '`22550CE` 205.55 → **518.8** (₹-20,361)\nSlippage vs trigger: ₹4.92\nLong `22850CE` still running to expiry.'),
    msg('6', '2026-11-11T04:01:00Z', '🟡 DRY · @here AVI-F — POSITION MISMATCH', 'NRML', [],
      '`NIFTY26N1725350CE` expected -65, broker has 0\n\nDB and broker disagree. Nothing was changed automatically.'),
  ]);
  assert.equal(evs[0].kind, 'spread_opened');
  assert.equal(evs[0].mode, 'live');
  assert.equal(evs[0].lots, 1);
  assert.equal(evs[0].short.strike, 22550);
  assert.equal(evs[0].credit, 7618);
  assert.equal(evs[1].kind, 'short_leg_stopped');
  assert.equal(evs[1].pnl, -20361);
  assert.equal(evs[1].longStillOpen, '22850CE');
  assert.equal(evs[2].mode, 'dry');
  assert.equal(evs[2].rows[0].expected, -65);
});

test('test-marker posts and the 4 after them are excluded', () => {
  const evs = parseNiftyMessages([
    msg('7', '2026-08-26T05:11:22Z', '🧪  ALERT RENDERING TEST — the next 4 messages are fake', null, [], 'Synthetic numbers'),
    msg('8', '2026-08-26T05:11:23Z', '📘  NIFTY Straddle Paper Trader — Armed', 'PAPER', []),
    msg('9', '2026-08-26T05:11:24Z', '📊  Straddle Paper — EOD Summary  2026-08-26', 'PAPER', [
      { name: '🧺 Basket net', value: '**Rs 2,653**' }]),
    msg('10', '2026-08-26T05:11:25Z', '📊  Straddle Paper — EOD Summary  2026-08-26', 'PAPER', [
      { name: '🧺 Basket net', value: '**Rs 2,653**' }]),
    msg('11', '2026-08-26T05:11:26Z', '📊  Straddle Paper — EOD Summary  2026-08-26', 'PAPER', [
      { name: '🧺 Basket net', value: '**Rs 2,653**' }]),
    msg('12', '2026-08-26T05:11:27Z', '📊  Straddle Paper — EOD Summary  2026-08-26', 'PAPER', [
      { name: '🧺 Basket net', value: '**Rs 2,653**' }]),
    msg('13', '2026-08-27T09:00:00Z', '📊  Straddle Paper — EOD Summary  2026-08-27', 'PAPER', [
      { name: '🧺 Basket net', value: '**Rs -411**' }]),
  ]);
  const real = evs.filter((e) => !e.synthetic);
  // The marker and the 4 posts after it (8-11) are fake; post 12 is the first real one
  assert.deepEqual(real.map((e) => e.id), ['12', '13']);
  const report = buildReport(evs);
  assert.equal(report.paper.days, 2);
  assert.equal(report.paper.basketNet, 2653 - 411);
});
