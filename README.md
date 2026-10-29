# dreamDEX Perps Feedback

Six independently reproduced **normal** Feedback candidates for the dreamDEX Perps Builder Bounty. Reports 01–03 formed the original DoraHacks submission; reports 04–06 are the October 30 follow-ups. The six-report package belongs to Build 50054. Acceptance, novelty and payment are determined by the organizer. They cover documentation/SDK/bot-kit correctness, not a demonstrated trading loss or contract exploit.

## Reproduce

Requirements: Node.js 24.11.1 and npm 11.18.0 were tested. The lockfile pins the installed dependency graph; the direct dependencies are markets-sdk 0.32.1 and viem 2.57.7. Both were obtained from the official npm registry. SDK license: MIT; its package retains the license notice.

```powershell
npm ci --ignore-scripts --no-audit --no-fund --cache ./.npm-cache
npm run verify
npm run survey
npm run verify:history
node scripts/verify-botkit-sizing.mjs
```

Run from this directory. These scripts do not read a private key, request a signature, claim funds or submit a transaction. `verify` uses public RPC/indexer reads and WebSocket watch acquisition/hydration; it closes the watch and exchange. The scripts have deadlines and save timestamped JSON in `evidence/`. The findings verification checks observations that establish the discrepancies; passing means the discrepancies were reproduced, not that the SDK was fixed.

`verify:history` checks reports 04–05 using actual indexed ETH perp events/candles and controls. It makes a fixed number of requests, including three pagination steps rather than an unbounded loop. Set `$env:ROUND2_BASE='BTC'` in PowerShell to use BTC instead, and `$env:ROUND2_OUTPUT='evidence/history-btc.json'` to keep a separate capture. Eight checks passed per market on both ETH and BTC. Historical event hashes are source evidence, not transactions sent by this investigation.

`verify-botkit-sizing.mjs` checks report 06. It verifies hashes of two official bot-kit source files at the pinned commit and executes their helper bodies with all writes replaced by `eth_call` or a blocking stub. Fourteen checks passed at Tokyo block 36620783: both default-slippage calls reject for margin; four original-price/resized controls return success. The public account is read/simulated without a key. Synthetic helper `sent`/`fills` values are not mined transactions or execution evidence. Node 24 built-in type stripping is used; historical RPC availability is required.

## Reports

- [01 — Exact decimal strings are silently rounded](feedback/01-exact-string-input-silently-rounded.md)
- [02 — fundingRate property documentation uses the wrong time basis](feedback/02-funding-rate-property-time-basis.md)
- [03 — Realtime guide contradicts the shipped perp watch capability](feedback/03-perp-watch-guide-contradiction.md)
- [04 — Funding-history +1 ms cursor repeats the same event](feedback/04-funding-history-millisecond-cursor-repeats.md) — October 30 follow-up
- [05 — OHLCV since cannot page the older candle history](feedback/05-ohlcv-since-cannot-page-old-history.md) — October 30 follow-up

- [06 — Bot-kit applies slippage after sizing and triggers a margin rejection](feedback/06-botkit-slippage-applied-after-sizing.md) — October 30 follow-up

Proposed severities are normal and remain subject to organizer review. Reports 01–05 use no account or signer. Report 06 uses a public historical account address for read-only simulation; it never uses a key, signer or broadcast. All target Hideki testnet (50383), the event's Tokyo/DreamDEX region.

## Scope and limits

The public REST service was reachable but its documented staging environment returned three Shannon spot markets, whereas the target SDK indexer returned 21 Hideki perps. This is recorded in the private workspace investigation notes as a documentation/access question, not asserted as a REST bug.

An unauthenticated browser reproduction of the Perps-to-spot redirect matched a pre-existing public report and was excluded. Known voucher, symbol-casing and missing-error reports were also excluded. Two public participant report indexes were reviewed for duplicate screening; the organizer's private Builds and unpublished reports remain inaccessible. Exact-string behavior touches the same helper as a pre-existing report about large numeric input and error classes, so duplicate treatment of that candidate is especially uncertain.

The October 30 follow-up screened six public participant indexes, official bot-kit issue/PR titles and the October 27 builder-session slides/known gotchas. No matching trigger for reports 04–06 was found there. Report 06 also distinguishes its size-before-slippage cause from existing resting-order cap, gas-floor and read-after-write findings. This is not complete novelty clearance: private submissions and a complete organizer-maintained known-issues list were not available. Report 05 explicitly distinguishes the current newest-window behavior from the forward-paging comparison in the SDK documentation and asks the maintainer to confirm that contract.

## Method transparency

AI assistance was used to investigate public documentation, prepare the scripts and write the reports. The included reproduction programs were executed against the pinned SDK and public testnet endpoints; their timestamped outputs are included. No claim is made that the organizer has approved AI assistance or accepted these items. No private key, signature, fund claim or transaction was used.

The organizer decides eligibility, duplicate precedence, severity and rewards. This repository contains no security vulnerability report.
