'use strict';
// Parses posts from the NIFTY straddle paper trader and the AVI-F spread bot.
//
// Event kinds:
//   straddle_entry   paper straddle leg pair opened (S1_0930 / S2_1030)
//   leg_closed       one paper leg closed (SL or EOD) with net P&L in rupees
//   eod_summary      end-of-day basket P&L per straddle, with leg detail
//   spread_opened    AVI-F credit spread opened. mode: live | dry
//   short_leg_stopped  AVI-F short leg hit its stop. mode: live | dry
//   position_mismatch  DB and broker disagree about contracts. mode: live | dry
//   weekly_report, results_report   the bot's own summaries (kept as posted)
//   test_marker      "ALERT RENDERING TEST": the next 4 posts are fake
//   other            anything else (health, holiday, failures, startup)

const IST = 'Asia/Kolkata';

const clean = (s) => (s == null ? '' : String(s).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim());

// Field names carry emoji ("📈  SELL CE 24900"); strip them for matching
const keyOf = (name) => clean(name).replace(/^[^\p{L}\p{N}]+/u, '').trim();

// "Rs 14,349", "₹-20,361", "Rs -3,384" -> -3384 etc.
function rupees(s) {
  const t = String(s || '').replace(/[`*]/g, '').replace(/−/g, '-').replace(/₹|Rs/g, '');
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(t);
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

// "24,875.40" -> 24875.4, "`118.50`" -> 118.5
function num(s) {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(clean(s).replace(/−/g, '-'));
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

const istDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(new Date(iso));

// Mode from the title prefix (LIVE · / DRY ·) or the paper footer
function modeOf(title, footer) {
  if (/\bLIVE\b/.test(title)) return 'live';
  if (/\bDRY\b/.test(title)) return 'dry';
  if (/PAPER/.test(footer || '') || /Straddle/.test(title)) return 'paper';
  return null;
}

// "PAPER · S1_0930" -> "S1_0930"
const strategyOf = (footer) => {
  const m = /(S\d_\d{4})/.exec(footer || '');
  return m ? m[1] : null;
};

// Straddle entry label -> strategy code, from the label in an EOD header ("Straddle930", "Straddle 10")
const strategyFromLabel = (label) => {
  if (/930/.test(label)) return 'S1_0930';
  if (/10\b|1030/.test(label)) return 'S2_1030';
  return null;
};

function parseEvent(m) {
  const e = (m.embeds || [])[0];
  if (!e) return null;
  const head = clean(e.title).replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
  const footer = clean(e.footer);
  const desc = e.description || '';
  const fields = (e.fields || []).map((f) => ({ key: keyOf(f.name), value: f.value || '' }));
  const get = (re) => {
    const f = fields.find((x) => re.test(x.key));
    return f ? f.value : '';
  };
  const exact = (k) => {
    const f = fields.find((x) => x.key === k);
    return f ? f.value : '';
  };
  const base = { id: m.id, timestamp: m.timestamp, date: istDate(m.timestamp), mode: modeOf(head, footer), url: m.url };

  if (/Spread Opened/.test(head)) {
    const sell = /(\d+)\s*(CE|PE)\s*@\s*₹?([\d.,]+)/.exec(exact('SELL'));
    const buy = /(\d+)\s*(CE|PE)\s*@\s*₹?([\d.,]+)/.exec(exact('BUY'));
    const lots = /(\d+)\s*lot/.exec(exact('Qty'));
    return {
      ...base,
      kind: 'spread_opened',
      spot: num(exact('Spot')),
      expiry: clean(exact('Expiry')),
      lots: lots ? Number(lots[1]) : null,
      short: sell ? { strike: Number(sell[1]), side: sell[2], price: num(sell[3]) } : null,
      long: buy ? { strike: Number(buy[1]), side: buy[2], price: num(buy[3]) } : null,
      credit: rupees(exact('Net credit')),
      shortSl: num(get(/^Short SL/)),
    };
  }

  if (/Short Leg Stopped/.test(head)) {
    const stop = /`(\d+)(CE|PE)`\s*([\d.]+)\s*→\s*\**([\d.]+)\**\s*\((₹-?[\d,.]+)\)/.exec(desc);
    const long = /Long `(\d+)(CE|PE)`/.exec(desc);
    const slip = /Slippage vs trigger: (₹-?[\d,.]+)/.exec(desc);
    return {
      ...base,
      kind: 'short_leg_stopped',
      contract: stop ? `${stop[1]}${stop[2]}` : null,
      side: stop ? stop[2] : null,
      strike: stop ? Number(stop[1]) : null,
      entry: stop ? num(stop[3]) : null,
      exitPx: stop ? num(stop[4]) : null,
      pnl: stop ? rupees(stop[5]) : null,
      slippage: slip ? rupees(slip[1]) : null,
      longStillOpen: long ? `${long[1]}${long[2]}` : null,
    };
  }

  if (/POSITION MISMATCH/.test(head)) {
    const rows = [...desc.matchAll(/`([^`]+)` expected (-?\d+), broker has (-?\d+)/g)].map((r) => ({
      contract: r[1], expected: Number(r[2]), broker: Number(r[3]),
    }));
    return { ...base, kind: 'position_mismatch', rows };
  }

  if (/Straddle Entry/.test(head)) {
    const legs = fields
      .map((f) => ({ f, m: /^SELL (CE|PE) (\d+)$/.exec(f.key) }))
      .filter((x) => x.m)
      .map(({ f, m: mm }) => ({
        side: mm[1],
        strike: Number(mm[2]),
        contract: (/`([A-Z0-9]+)`/.exec(f.value) || [])[1] || null,
        entry: num((/Entry `([\d.]+)`/.exec(f.value) || [])[1]),
        sl: num((/SL `([\d.]+)`/.exec(f.value) || [])[1]),
      }));
    return {
      ...base,
      date: istDate(m.timestamp),
      kind: 'straddle_entry',
      strategy: strategyOf(footer),
      spot: num(get(/^Spot at entry/)),
      credit: rupees(get(/^Credit received/)),
      legs,
    };
  }

  if (/Leg Closed/.test(head)) {
    const contract = (/`([A-Z0-9]+)`/.exec(get(/^Contract/)) || [])[1] || null;
    const sideM = /(CE|PE)$/.exec(head);
    // NIFTY strikes are 5 digits; the digits before them are the expiry code
    const strikeM = contract ? /(\d{5})(CE|PE)$/.exec(contract) : null;
    const trail = get(/^Trail/);
    return {
      ...base,
      kind: 'leg_closed',
      strategy: strategyOf(footer),
      side: sideM ? sideM[1] : null,
      contract,
      strike: strikeM ? Number(strikeM[1]) : null,
      reason: clean(get(/^Reason/)) || null,
      exitAt: clean(exact('Exit')) || null,
      exitDate: (clean(exact('Exit')) || '').slice(0, 10) || null,
      entry: num(exact('Entry')),
      exitPx: num(get(/^Exit px/)),
      trailSteps: num((/`(\d+)` steps/.exec(trail) || [])[1]),
      gross: rupees(exact('Gross')),
      costs: rupees(get(/^Costs/)),
      net: rupees(exact('Net')),
    };
  }

  if (/EOD Summary/.test(head)) {
    const date = (/(\d{4}-\d{2}-\d{2})/.exec(head) || [])[1] || base.date;
    const groups = [];
    for (const f of fields) {
      const gm = /^(Straddle\s*\d+)\s*—\s*Rs\s*(-?[\d,]+)/.exec(f.key);
      if (!gm) continue;
      const legs = [...f.value.matchAll(/`(CE|PE) (\d+)`\s+([\d.]+) → ([\d.]+)\s+\((\w+)\)\s+\**(Rs -?[\d,]+)\**/g)]
        .map((r) => ({
          side: r[1], strike: Number(r[2]), entry: num(r[3]), exit: num(r[4]),
          reason: r[5], net: rupees(r[6]),
        }));
      groups.push({ label: gm[1].replace(/\s+/g, ' '), strategy: strategyFromLabel(gm[1]), net: rupees(gm[2]), legs });
    }
    return { ...base, date, kind: 'eod_summary', groups, basketNet: rupees(get(/Basket net/)) };
  }

  if (/Weekly Report/.test(head)) return { ...base, kind: 'weekly_report', text: head };
  if (/Results Since Deploy/.test(head)) return { ...base, kind: 'results_report', text: head, body: desc };
  if (/ALERT RENDERING TEST/.test(head)) return { ...base, kind: 'test_marker' };
  return { ...base, kind: 'other', title: head, synthetic: /synthetic/i.test(desc) };
}

// Parse a list of messages (slim format from fetch.js). Posts the bot labels as fake
// tests are marked synthetic and excluded from the analysis.
function parseNiftyMessages(messages) {
  const sorted = [...messages].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const events = [];
  let fakeLeft = 0;
  for (const m of sorted) {
    const ev = parseEvent(m);
    const fake = fakeLeft > 0;
    if (fakeLeft > 0) fakeLeft--;
    if (!ev) continue;
    if (ev.kind === 'test_marker') {
      fakeLeft = 4;
      ev.synthetic = true;
    } else {
      ev.synthetic = fake || !!ev.synthetic;
    }
    events.push(ev);
  }
  return events;
}

module.exports = { parseNiftyMessages, parseEvent, rupees, num, istDate };
