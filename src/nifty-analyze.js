#!/usr/bin/env node
'use strict';
// Parses the NIFTY straddle / AVI-F channel and writes reports.
//   node src/nifty-analyze.js                         # data/messages.jsonl
//   node src/nifty-analyze.js --file path/to/export.jsonl

const fs = require('node:fs');
const path = require('node:path');
const { parseNiftyMessages } = require('./nifty/parse');
const { buildReport, renderMarkdown, legsCsv } = require('./nifty/report');

const ROOT = path.join(__dirname, '..');
const i = process.argv.indexOf('--file');
const file = i !== -1 ? process.argv[i + 1] : path.join(ROOT, 'data', 'messages.jsonl');

if (!fs.existsSync(file)) {
  console.error(`${file} not found. Run: npm run fetch`);
  process.exit(1);
}
const messages = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const events = parseNiftyMessages(messages);
const report = buildReport(events);

const outDir = path.join(ROOT, 'reports');
fs.mkdirSync(outDir, { recursive: true });
const md = renderMarkdown(report);
fs.writeFileSync(path.join(outDir, 'nifty-summary.md'), md + '\n');
fs.writeFileSync(path.join(outDir, 'nifty-legs.csv'), legsCsv(report));
console.log(md);
console.log(`\nSynthetic posts excluded: ${events.filter((e) => e.synthetic).length}. Wrote reports/nifty-summary.md and nifty-legs.csv`);
