# proddatur-trader

Reads the full message history of one Discord channel and measures how the options signals posted there performed.

It reuses the alert parser from [prime-intra](https://github.com/sudharshanreddyam/prime-intra) (`src/vendor/alerts.js`), so posts in the same format are read the same way.

```
Discord REST API ──▶ src/fetch.js ──▶ data/messages.jsonl ──▶ src/analyze.js ──▶ reports/summary.md
                                                                              └──▶ reports/contracts.csv
```

## Setup

Requires Node.js 18+. There are no npm dependencies.

1. Create a bot in the Discord Developer Portal, copy its token, and turn on **Message Content Intent** (without it, message text arrives empty).
2. Add the bot to the server with **View Channels** and **Read Message History** on the target channel.
3. `cp .env.example .env` and set `DISCORD_TOKEN`.

## Run

```bash
npm run fetch      # downloads new messages (re-runs only add what's missing)
npm run analyze    # writes reports/summary.md, contracts.csv, summary.json
```

`npm run fetch -- --since 2026-08-26` stops at that date.

## How signals are measured

- One row = one contract (ticker + strike + call/put) per trading day, the same as prime-intra's board.
- **Entry** comes from the first alert post for the contract that day.
- **Follow-up posts** (`+150% — …`, `-25% — …`, `EOD — …`) give the P&L path. Best and worst are the highest and lowest values seen.
- **Final** = the EOD post's P&L if there is one, otherwise the last follow-up post. Contracts with no follow-up posts aren't scored.
- **Win rate** = share of scored contracts with a final P&L above 0.
- Hit rates (+50%, +100%, −50%) use every contract that has a follow-up post.

These numbers come from what the channel posted, not from fills. Option quotes in the channel may differ from what a trader could actually get, so treat them as a read on the signal, not a backtest of a strategy.

## Output

- `reports/summary.md`: overall stats, then breakdowns by signal, side, days to expiry, day and ticker.
- `reports/contracts.csv`: one line per contract with entry, best, worst, final and a link to the alert post.
- `reports/summary.json`: the same numbers for scripts.

## NIFTY straddle and AVI-F channel

The `#indian-option-seller` channel carries a different bot: NIFTY paper straddles, plus AVI-F credit spreads that trade real money. `npm run analyze:nifty` parses it.

- Straddle legs and daily basket P&L come from the bot's EOD summaries, which list every leg.
- AVI-F posts are tagged `LIVE` (broker fills) or `DRY`, and paper posts are tagged `PAPER`. Live and paper results are reported separately.
- Posts the bot labels as fake test output are excluded: the "ALERT RENDERING TEST" post and the 4 posts after it.
- Output: `reports/nifty-summary.md` and `reports/nifty-legs.csv`.

## Tests

```bash
npm test    # NIFTY parser tests, then the prime-intra analysis on test/fixtures/messages.jsonl
```

## Not included

- No trading. The reader never places orders.
- The bot token and the data stay on your machine (`.env` and `data/` are gitignored).
