# SDK funding-history pagination repeats the last event with the documented +1 ms cursor
Severity: normal
Area: SDK

## Steps to reproduce
1. Install the pinned dependencies with `npm ci --ignore-scripts --no-audit --no-fund`.
2. Run `npm run verify:history`. It uses public reads only, discovers the live ETH perp symbol and records the requests' arguments and complete SDK responses. For BTC, set `$env:ROUND2_BASE='BTC'` in PowerShell and rerun.
3. Request `page = await exchange.fetchFundingRateHistory(symbol, startMs, 1)` using the timestamp of a recent real funding event as `startMs`.
4. Follow the SDK's published pagination example: set `since = page.at(-1).timestamp + 1` and request the next page with the same limit. Repeat once more.
5. As a control, advance by 1,000 ms instead of 1 ms. Also inspect the separate limit-100 call immediately after the latest event.

## Expected
`since` is documented as an inclusive unix-milliseconds forward cursor. No returned row should have `timestamp < since`. The published `last.timestamp + 1` recipe should advance and eventually return an empty array, rather than repeatedly returning the same final event.

## Actual
On both ETH and BTC, adding 1 ms returns the same indexed event and timestamp. A third call remains stuck. The limit-100 tail call likewise includes an event older than its supplied lower bound, so the problem is not restricted to a one-row page.

ETH sample from the captured run:

```text
first timestamp:  1793308758000 (2026-10-29T21:19:18.000Z)
next since:       1793308758001
second timestamp: 1793308758000
third timestamp:  1793308758000
repeated id:      0xd6cb1dd58580b84d76068ac21594219ce03aeddf_36555446_25
control +1000ms:  1793312359000 (a different event)
```

Root cause: `fetchFundingRateHistory` converts `since` with `Math.floor(since / 1000)` before calling `listFundingRateHistory`; that reader uses an inclusive `_gte` seconds filter. A 1 ms advance is rounded back to the same second. The returned rows are not filtered against the original millisecond cursor. This defeats the termination recipe in its own TSDoc and release notes. It can duplicate chart/accounting inputs or leave an unguarded import loop running. No user loss or actual unbounded request loop was generated; the reproducer makes a fixed number of reads.

## Evidence
- [Read-only reproducer](../scripts/verify-history-round2.mjs).
- [ETH capture](../evidence/history-round2-eth-final.json), `observations.funding`: first/second/third, whole-second control and tail result; eight checks passed for this market across both reports.
- [BTC capture](../evidence/history-round2-btc-final.json): same defect and controls; eight checks passed.
- Existing indexed ETH event transaction: `0x65d08031e8d0208d9722a0e9d5cb61082be620cb23d933cdcdbe43cd6baaca5d`. This is a historical event read from the indexer, not a transaction sent by the investigator.
- Published package: `src/unified/exchange.ts`, `fetchFundingRateHistory`; `src/perp/history.ts`, `listFundingRateHistory`; corresponding declarations in `dist/`.
- [Official SDK release notes](https://prd.smk.somnia.host/docs/typescript/release-notes), v0.23.0 funding-pagination change; [pinned npm package](https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1).

## Environment
SDK: `@somnia-chain/markets-sdk@0.32.1`; viem: `2.57.7`; Node.js: `24.11.1`; Windows; verified 2026-10-30 UTC+7.
Network: Somnia Tokyo testnet (Hideki), chain `50383`.
Indexer: `https://hideki-dev.smk.somnia.host/v1/graphql`.
ETH pool: `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`.
BTC pool: `0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0`.
Wallet address: not applicable; no account, key, signer or transaction used.

## Suggested fix
Translate an inclusive millisecond lower bound to the first eligible indexed second using `Math.ceil(since / 1000)`, with finite/safe input validation. Preserve `since` exactly at second boundaries. Add regression cases for exact-boundary inclusion, `+1` ms with limit 1, an exhausted tail with limit 100, and a timestamp without any row. If multiple events can share a timestamp, expose a composite/opaque event cursor for complete paging; rounding alone does not solve that separate limitation. Until fixed, whole-second advancement is a workaround only when skipping same-second events is acceptable.

## Review status and duplicate risk
October 30 follow-up candidate prepared for the existing Feedback Build 50054. No matching trigger was found in six reviewed public participant indexes, the official bot-kit issue/PR titles or the session's known-gotcha slides. Another participant's funding-history configuration error is a different trigger. Private submissions and a complete organizer known-issues list are unavailable; novelty, acceptance, severity and payment remain the organizer's decision.
