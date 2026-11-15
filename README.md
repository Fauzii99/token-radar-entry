# token-radar-entry

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Fauzii99/token-radar-entry/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Fauzii99/token-radar-entry/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token-launch radar for pre-token protocols. It reads the sealed 758-row DefiLlama snapshot, fits a
category-level log-log regression of market cap against TVL with empirical-Bayes-style shrinkage toward
the pooled curve (k = 4 pseudo-peers), and ranks the 198 kept protocols by an **implied market-cap proxy**.
Every number is an estimate from those ten observed fields and nothing else: no FDV, no fees, no revenue,
no users, and no claim that a protocol will or will not launch a token.

## What it does

- **Board** — 198 rows with implied proxy, out-of-fold P10–P90 band, whole multiple of TVL, observed TVL,
  7-day TVL change, tracking age, peer count, confidence and a value tag. Sortable on every numeric column
  with shift-click multi-key sorting, filterable by category, chain, confidence and value tag.
- **Detail drawer** for every row — the arithmetic behind the number (pooled curve multiple → category
  offset → seven-day and tracking-age tilts → product), the nearest observed peers, the residual band drawn
  on a log axis, and a 10-step farm plan.
- **Proof panel** — the real leave-one-out cross-validation: 128 folds refit without the target, compared
  against naive category multiples on RMSLE, MdAPE and the fraction of predictions within a factor of two.
  The model wins on all three (2.124 vs 2.441 RMSLE), and the board says plainly that only 33% of
  predictions land within 2x.

## Run it

```sh
# Node 22.18+, no dependencies, no network
node main.ts --input /path/to/snapshot.json        # or --input containing snapshot.json
# writes board.json, data.js, dashboard/, screenshots/, dossier.json to $MAKEFUN_OUTPUT_DIR (default /output)
MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
```

Open `out/dashboard/index.html` in a browser. The page is fully offline: it reads `../data.js` and
`app.js`, with no external requests, no fonts and no CDN.

## Layout

```
main.ts               entrypoint: parse, fit, gate, write
lib/model.ts          universe, peer fit, LOO validation, bands, farm plans, data.js serializer
dashboard/app.js      the page: KPI strip, scatter, board, drawer, methodology
dashboard/app.css     one palette per theme, one type scale, one spacing scale
vendor/makefun-board.ts  vendored dossier builder (unmodified)
screenshots/          the three judge-facing captures
```

## Honest limits

- The proxy is a **market-cap** estimate, never an FDV or a valuation.
- The band is the out-of-fold P10–P90 residual range, not a confidence interval on the future.
- Tracking age is time since the protocol first appears in the tracked record, not founding age.
- Farm plans are hypothetical: capital and gas tiers are assumptions, nothing is a live quote, no wallet
  is touched, and no eligibility, points or airdrop is promised.
- Exclusions are conservative inferences from observed fields (derivative of a parent with a token,
  versioned fork, token-family match). "Records no token" is the claim, not "has no token".

---

<sub>Entered on [make.fun](https://make.fun/?ref=pg1dyky2&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
