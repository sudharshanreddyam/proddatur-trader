// Parses options-alert posts like:
//
//   0DTE PRIME — META $740C (0DTE)
//   VOL_CROSS_OI · fired 08:45 CT
//   Symbol        `META261012C00740000`
//   Entry (ref)   $8.05
//   Type          Same-day expiry CALL
//   Play          Scalp the spike — peaks late-day. Cut losers fast.
//   ⚠️ 0DTE • HIGH RISK • total-loss likely • alert-only • NOT financial advice
//
// Works whether the bot posts it as an embed (title/description/fields/footer)
// or as plain text (label on one line, value on the next, or "Label: value").

// Extra board columns, read from the post when the alert bot includes them
const EXTRA_LABELS = {
  clu: ['clu', 'cluster'],
  align: ['align', 'alignment'],
  conv: ['conv', 'conviction'],
  prem: ['prem', 'premium'],
  volOi: ['vol/oi', 'vol / oi', 'vol-oi', 'volume/oi'],
  stockMv: ['stock mv', 'stock move'],
};

const KNOWN_LABELS = ['symbol', 'entry (ref)', 'entry', 'type', 'play', 'target', 'stop', 'exit', 'size', 'notes',
  'now', 'p&l', 'pnl',
  ...Object.values(EXTRA_LABELS).flat()];

const clean = (s) => (s == null ? '' : String(s).replace(/`/g, '').replace(/\*\*/g, '').trim());

// OCC option symbol: ROOT + YYMMDD + C/P + strike*1000 (8 digits)
const OCC_RE = /\b([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})\b/;

function decodeOcc(text) {
  const m = OCC_RE.exec(clean(text));
  if (!m) return null;
  const [, root, yy, mm, dd, cp, strike] = m;
  return {
    occ: m[0],
    underlying: root,
    expiry: `20${yy}-${mm}-${dd}`,
    right: cp === 'C' ? 'CALL' : 'PUT',
    strike: Number(strike) / 1000,
  };
}

// "0DTE PRIME — META $740C (0DTE)"
const HEADLINE_RE = /^(.*?)\s*[—–-]+\s*\$?([A-Z][A-Z.]{0,5})\s+\$?(\d+(?:\.\d+)?)\s*([CP])\b\s*(?:\(([^)]+)\))?/;
// "VOL_CROSS_OI · fired 08:45 CT"
// (several signals can fire together: "STREAK,VOL_CROSS_OI · fired 09:15 CT")
const SIGNAL_RE = /^([A-Z][A-Z0-9_ ,]*?)\s*[·•|-]\s*fired\s+(\d{1,2}:\d{2}(?:\s*[AP]M)?)\s*([A-Z]{1,4})?/i;

// YYYY-MM-DD of a moment, in New York time
function marketDate(when) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(when));
}

// Update posts: "-25% — META $740C cracked -25%", "+150% — AMZN $258C hit +150%"
const UPDATE_RE = /^([+\-−]\d+(?:\.\d+)?)%\s*[—–]+\s*\$?([A-Z][A-Z.]{0,5})\s+\$?(\d+(?:\.\d+)?)\s*([CP])\b\s*(.*)$/;
// End-of-day posts: "EOD — USAR $10C → +204%"
const EOD_RE = /^EOD\b\s*[—–:-]+\s*\$?([A-Z][A-Z.]{0,5})\s+\$?(\d+(?:\.\d+)?)\s*([CP])\b(?:\s*(?:→|->|=>|:)?\s*([+\-−]?\d+(?:\.\d+)?)\s*%)?/;
// "... | 2026-10-09 14:37 CT"
const STAMP_RE = /(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*CT\b/;
const pctNum = (s) => {
  const m = clean(s).replace(/−/g, '-').match(/[+-]?\d+(?:\.\d+)?(?=\s*%)/);
  return m ? Number(m[0]) : null;
};

function money(s) {
  const m = clean(s).match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
  return m ? Number(m[0].replace(/,/g, '')) : null;
}

// Plain-text: turn "Label\nValue" and "Label: Value" lines into a map
function labelPairs(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = clean(lines[i]);
    const lower = line.toLowerCase();
    if (KNOWN_LABELS.includes(lower) && i + 1 < lines.length) {
      out[lower] = clean(lines[++i]);
      continue;
    }
    const kv = line.match(/^([A-Za-z][\w ()./-]{0,30}?)\s*:\s+(.+)$/);
    if (kv && KNOWN_LABELS.includes(kv[1].toLowerCase())) out[kv[1].toLowerCase()] = clean(kv[2]);
  }
  return out;
}

function parseAlert(post) {
  // Collect every text line the post carries, in reading order
  const lines = [];
  const fieldMap = {};
  for (const e of post.embeds || []) {
    if (e.author) lines.push(e.author);
    if (e.title) lines.push(e.title);
    if (e.description) lines.push(...e.description.split(/\r?\n/));
    for (const f of e.fields || []) fieldMap[clean(f.name).toLowerCase()] = clean(f.value);
    if (e.footer) lines.push(e.footer);
  }
  if (post.content) lines.push(...post.content.split(/\r?\n/));
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const fields = { ...labelPairs(nonEmpty), ...fieldMap }; // embed fields win

  const alert = {};

  // Is this a follow-up on an earlier alert (milestone / drawdown / end of day)?
  // Real posts often lead with an emoji ("🎯 +100% — …", "⚠️ -25% — …", "📊 EOD — …"): ignore it.
  const head = (l) => clean(l).replace(/^[^\w+\-−$]+/u, '').replace(/^−/, '-');
  const upIdx = nonEmpty.findIndex((l) => UPDATE_RE.test(head(l)) || EOD_RE.test(head(l)));
  if (upIdx !== -1 && upIdx < 3) {
    const line = head(nonEmpty[upIdx]);
    const u = UPDATE_RE.exec(line);
    const e = u ? null : EOD_RE.exec(line);
    const [ticker, strike, cp] = u ? [u[2], u[3], u[4]] : [e[1], e[2], e[3]];
    const headPct = u ? Number(u[1]) : e[4] != null ? Number(e[4].replace('−', '-')) : null;
    const pnl = pctNum(fields['p&l'] ?? fields.pnl);
    const stamp = nonEmpty.map((l) => STAMP_RE.exec(l)).find(Boolean);
    const note = clean(nonEmpty[upIdx + 1] || '');
    alert.kind = 'update';
    alert.ticker = ticker;
    alert.strike = Number(strike);
    alert.right = cp === 'C' ? 'CALL' : 'PUT';
    alert.headline = line;
    alert.update = {
      threshold: u ? headPct : null,
      label: u ? u[5].trim() || null : 'EOD', // "cracked -25%", "hit +150%", "EOD"
      note: STAMP_RE.test(note) || /⚠/.test(note) || KNOWN_LABELS.includes(note.toLowerCase()) ? null : note,
      entry: money(fields.entry ?? fields['entry (ref)']),
      now: money(fields.now),
      pnl: pnl ?? (u ? pctNum(note) : null) ?? headPct,
      date: stamp ? stamp[1] : null,
      at: stamp ? stamp[2].padStart(5, '0') : null,
    };
    alert.update.kind = e ? 'eod' : alert.update.pnl < 0 ? 'drawdown' : 'milestone';
  }

  for (const raw of alert.kind === 'update' ? [] : nonEmpty) {
    const line = clean(raw);
    if (!alert.ticker) {
      const h = HEADLINE_RE.exec(line);
      if (h) {
        alert.tier = h[1].trim() || null;
        alert.ticker = h[2];
        alert.strike = Number(h[3]);
        alert.right = h[4] === 'C' ? 'CALL' : 'PUT';
        alert.tag = h[5] || null;
        alert.headline = line;
        continue;
      }
    }
    if (!alert.signal) {
      const s = SIGNAL_RE.exec(line);
      if (s) {
        alert.signal = s[1].split(',').map((x) => x.trim()).filter(Boolean).join(',');
        alert.firedAt = s[2] + (s[3] ? ' ' + s[3].toUpperCase() : '');
        continue;
      }
    }
    if (!alert.risk && /⚠|not financial advice|high risk/i.test(line)) {
      alert.risk = line
        .replace(/⚠️?/g, '')
        .replace(/\s*(?:Today|Yesterday) at .*$/i, '') // Discord's rendered timestamp
        .split(/\s*•\s*/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }

  // Option contract: prefer the OCC symbol, it's unambiguous
  const occ = decodeOcc(fields.symbol) || nonEmpty.map(decodeOcc).find(Boolean);
  if (occ) {
    alert.occ = occ.occ;
    alert.expiry = occ.expiry;
    alert.ticker = alert.ticker || occ.underlying;
    if (alert.strike != null && (alert.strike !== occ.strike || (alert.right && alert.right !== occ.right))) {
      alert.mismatch = `Headline says ${alert.strike}${alert.right[0]}, symbol says ${occ.strike}${occ.right[0]}`;
    }
    // The symbol is authoritative (e.g. headline "$258C" for a 257.5 strike)
    alert.strike = occ.strike;
    alert.right = occ.right;
  }

  if (!alert.ticker) return null; // not an alert post
  if (alert.kind === 'update') return alert;
  alert.kind = 'alert';

  const entryRaw = fields["entry (ref)"] ?? fields.entry;
  if (entryRaw) {
    alert.entryText = entryRaw;
    alert.entry = money(entryRaw);
  }
  if (fields.type) alert.type = fields.type;
  if (fields.play) alert.play = fields.play;
  if (fields.target) alert.target = fields.target;
  if (fields.stop) alert.stop = fields.stop;

  alert.extras = {};
  for (const [key, labels] of Object.entries(EXTRA_LABELS)) {
    const v = labels.map((l) => fields[l]).find((x) => x != null && x !== '');
    if (v != null) alert.extras[key] = v;
  }

  if (alert.expiry && post.createdAt) {
    // Days to expiry, counted on the US market calendar date (New York time)
    const postedDay = Date.parse(marketDate(post.createdAt) + 'T00:00:00Z');
    alert.dte = Math.round((Date.parse(alert.expiry + 'T00:00:00Z') - postedDay) / 86400000);
  } else if (/0\s*DTE|same-day/i.test(`${alert.tag} ${alert.tier} ${alert.type}`)) {
    alert.dte = 0;
  }

  return alert;
}

// ---------- #brad-actions (BRAD Combo Signal bot) ----------
// "⚡ ⚡ HIGH CONVICTION COMBO  |  TSLA $362.5 Put  |  Oct 16  (0d)  |  Mega Cap"
// with fields Entry **$5.73**, Conviction "· **WEAK** (1/7) · ~6% reach +100%", Vol/OI, Premium, …
const BRAD_RE = /(HIGH CONVICTION COMBO|EXTREME FLOW COMBO[^|]*)\s*\|\s*([A-Z][A-Z.]{0,5})\s+\$(\d+(?:\.\d+)?)\s+(Call|Put)\s*\|\s*([A-Z][a-z]{2})\s+(\d{1,2})\s*\((\d+)d\)\s*(?:\|\s*(.+))?$/;
const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function parseBradAlert(post) {
  const e = (post.embeds || [])[0];
  const m = BRAD_RE.exec(clean(e?.title || post.content?.split(/\r?\n/)[0] || ''));
  if (!m) return null;
  const [, kind, ticker, strikeText, side, mon, day, dte, cap] = m;
  const fields = Object.fromEntries((e?.fields || []).map((f) => [clean(f.name).toLowerCase(), clean(f.value)]));
  // Expiry year: the post's year, or the next one when the month has wrapped around (Dec post, Jan expiry)
  const posted = marketDate(post.createdAt || Date.now());
  let year = Number(posted.slice(0, 4));
  if (MONTHS[mon] < Number(posted.slice(5, 7)) - 6) year += 1;
  const expiry = `${year}-${String(MONTHS[mon]).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const strike = Number(strikeText);
  const right = side === 'Call' ? 'CALL' : 'PUT';
  const occ = `${ticker.replace('.', '')}${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${right[0]}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
  // The score can be negative: "· **WEAK** (-3/7) · ~6% reach +100%"
  const conv = /(WEAK|LOW|MED|HIGH)\s*\(([-−+]?\d)\/7\)/.exec(fields.conviction || '');
  // Stock field: "$6.37\n+8.4% ✅ aligned" -> price at the alert and the stock's move so far that day
  const stk = /\$\s*([\d,]+(?:\.\d+)?)\s*([-−+]\s*\d+(?:\.\d+)?%)?/.exec(fields.stock || '');
  const stockPrice = stk ? Number(stk[1].replace(/,/g, '')) : null;
  const stockMv = stk?.[2] ? stk[2].replace('−', '-').replace(/\s+/g, '') : undefined;
  return {
    kind: 'alert', source: 'brad', tier: /EXTREME/.test(kind) ? 'EXTREME FLOW COMBO' : 'HIGH CONVICTION COMBO',
    ticker, strike, right, expiry, dte: Number(dte), occ, headline: clean(e?.title || ''),
    entry: money(fields.entry), entryText: fields.entry || null,
    // The trader's SIGNALS filter matches this, e.g. BRAD_SIGNALS=CONV_HIGH
    signal: conv ? `CONV_${conv[1]}` : 'CONV_NONE', conviction: conv ? `${conv[1]} ${conv[2].replace('−', '-')}/7` : null,
    cap: cap ? cap.trim() : null, stockPrice, extras: { stockMv, conv: conv ? `${conv[1]} ${conv[2].replace('−', '-')}/7` : undefined, volOi: fields['vol/oi'], prem: fields.premium },
  };
}

module.exports = { parseAlert, parseBradAlert, decodeOcc, marketDate };

// ---------- earnings mentions (any watched channel) ----------
// Recognizes posts like "$NVDA earnings after close today", "TSLA ER tomorrow BMO", "AAPL, MSFT report 11/07 before the open".
// Strong evidence: the word "earnings", or "reports ... before/after/tomorrow". The bare tokens ER / BMO / AMC are also tickers
// (BMO = Bank of Montreal), so they only count in capitals AND next to a day or session word.
const EARN_STRONG_RE = /\bearnings?\b|\breports?\b[^.\n]{0,40}\b(?:before|after|pre-?market|post-?market|tomorrow|today|tonight)\b/i;
const EARN_TOKEN_RE = /\b(?:ER|BMO|AMC)\b/;
const EARN_CONTEXT_RE = /\b(?:today|tonight|tomorrow|tmrw|this (?:week|morning|afternoon)|before (?:the )?(?:market )?(?:open|bell)|after (?:the )?(?:market )?(?:close|bell)|pre-?market|post-?market|\d{1,2}\/\d{1,2}|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri)(?:day)?)\b/i;
const EARN_RE = { test: (t) => EARN_STRONG_RE.test(t) || (EARN_TOKEN_RE.test(t) && EARN_CONTEXT_RE.test(t)) };
const BMO_RE = /\bBMO\b|before\s+(?:the\s+)?(?:market\s+)?(?:open|bell)|pre-?\s?market|before\s+market|premarket|this\s+morning/i;
const AMC_RE = /\bAMC\b|after\s+(?:the\s+)?(?:market\s+)?(?:close|bell|market)|post-?\s?market|after[- ]hours|\bAH\b|tonight|after\s+close/i;
const NOT_TICKERS = new Set(['ER', 'BMO', 'AMC', 'AH', 'PM', 'AM', 'ET', 'CT', 'EST', 'EDT', 'CST', 'CDT', 'EPS', 'IV', 'OI', 'DTE', 'USD', 'CEO', 'CFO', 'THE', 'AND', 'FOR',
  'CALL', 'PUT', 'ALL', 'NEW', 'TODAY', 'NEXT', 'WEEK', 'HIGH', 'LOW', 'BUY', 'SELL', 'ITM', 'OTM', 'ATM', 'PRIME', 'EOD', 'BEAT', 'MISS', 'QTR', 'AFTER', 'BEFORE', 'OPEN', 'CLOSE', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN',
  'BRAD', 'COMBO', 'BUILDING', 'PRESSURE', 'SUSTAINED', 'STILL', 'SKIP', 'WAIT', 'MONITOR', 'ACTION', 'STOCK', 'DAYS', 'NEXT', 'DATA', 'NOT']);

function parseEarnings(post) {
  const parts = [post.content || ''];
  for (const e of post.embeds || []) {
    parts.push(e.author, e.title, e.description, e.footer, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`));
  }
  const text = parts.filter(Boolean).map(clean).join('\n');
  if (!text || !EARN_RE.test(text)) return null;

  // Tickers: cashtags first, then the alert's ticker, then bare ALL-CAPS words
  const tickers = [];
  const add = (t) => { t = t.replace(/\.$/, ''); if (t && !NOT_TICKERS.has(t) && !tickers.includes(t)) tickers.push(t); };
  for (const m of text.matchAll(/\$([A-Z]{1,5}(?:\.[A-Z])?)\b(?!\s*\d)/g)) add(m[1]);
  if (post.alert?.ticker) add(post.alert.ticker);
  // Embed titles like "BUILDING PRESSURE — NVDA  |  5 days": the ticker follows the dash
  for (const e of post.embeds || []) {
    const t = /[—–]\s*\$?([A-Z]{1,5}(?:\.[A-Z])?)\s*(?:\||$)/.exec(clean(e.title || ''));
    if (t) add(t[1]);
  }
  if (!tickers.length) for (const m of text.matchAll(/\b([A-Z]{2,5})\b/g)) add(m[1]);
  if (!tickers.length) return null;

  const session = BMO_RE.test(text) ? 'BMO' : AMC_RE.test(text) ? 'AMC' : null;
  const posted = marketDate(post.createdAt || Date.now());
  const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  let date = null;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  const md = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(text);
  const named = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(text);
  if (iso) date = iso[1];
  else if (/\btomorrow\b|\bnext (?:trading )?day\b/i.test(text)) date = addDays(posted, 1);
  else if (/\btoday\b|\btonight\b|\bthis (?:morning|afternoon)\b/i.test(text)) date = posted;
  else if (named) {
    const mon = MONTHS[named[1][0].toUpperCase() + named[1].slice(1, 3).toLowerCase()];
    date = `${posted.slice(0, 4)}-${String(mon).padStart(2, '0')}-${String(named[2]).padStart(2, '0')}`;
  } else if (md && Number(md[1]) <= 12 && Number(md[2]) <= 31) {
    date = `${posted.slice(0, 4)}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  // Pre-market earnings posted after the close refer to the next morning
  if (!date && session === 'BMO') date = addDays(posted, 1);
  if (!date && session === 'AMC') date = posted;

  const summary = text.split('\n').find((l) => EARN_RE.test(l)) || text.split('\n')[0];
  return { tickers, session, date, when: date ? (date === posted ? 'today' : date === addDays(posted, 1) ? 'tomorrow' : date) : null, summary: summary.slice(0, 300) };
}

module.exports.parseEarnings = parseEarnings;
