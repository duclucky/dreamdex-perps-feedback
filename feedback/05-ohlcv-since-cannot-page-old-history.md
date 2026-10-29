# SDK fetchOHLCV applies since after selecting the newest candles, preventing forward historical paging
Severity: normal
Area: SDK

## Steps to reproduce
1. Install the pinned dependencies and run `npm run verify:history` (no account or signer).
2. The script reads the latest two ETH one-minute candles, then uses `client.getCandles(pool, 60, {to, limit: 2, market})` to locate two real older candles at least an hour earlier.
3. Read the older bounded range using `client.getCandles(pool, 60, {from, to, limit: 2, market})` to confirm the source has those candles.
4. Call `exchange.fetchOHLCV(symbol, '1m', olderTimestampMs, 2)` and compare its timestamps with the bounded result.
5. Repeat on BTC with `$env:ROUND2_BASE='BTC'`. The script also checks that a future `since` returns an empty array.

## Expected
A historical forward cursor should start from the requested old range, making the existing early candles reachable with a bounded page size. The SDK funding-history TSDoc explicitly compares its forward-with-`since` behavior to `fetchOHLCV`, but that split is absent from the candle implementation.

If the intended contract is instead only to filter a newest-N snapshot, document that limitation explicitly, remove the misleading comparison and provide a supported historical paging route. This report does not assume every CCXT method must be implemented identically.

## Actual
The older candles exist and are returned by the exact-range client control. The unified call with the same old `since` and limit 2 returns only the newest two candles, skipping the requested older history. Advancing from that result cannot recover the skipped candles. At a fixed source snapshot, changing `since` within the older range has no effect on which newest candles are fetched.

ETH sample:

```text
requested since:       1793310300000
native range buckets:  1793310300000, 1793310420000
unified result:        1793314440000, 1793314500000
```

Root cause: `fetchOHLCV` calls `getCandles` with only `{limit, market}`. The query selects `bucketStart: desc` and limits the newest rows; the helper then sorts that page ascending. Only after that selection does the facade filter `timestamp >= since`. It never sends `since` to the source or asks for ascending selection from a cursor. Adding just a lower-bound `from` would still select the newest N rows and would not fix forward paging.

Impact: a chart/backtest/import using the documented facade comparison cannot retrieve a complete older range via a small forward page. This is a historical-selection/contract issue, not evidence of corrupted prices or missing indexer records. Future-bound filtering does work, as the control shows.

## Evidence
- [Read-only reproducer](../scripts/verify-history-round2.mjs).
- [ETH capture](../evidence/history-round2-eth-final.json), `observations.candles`: older source rows, exact-range control, requested `since`, unified result and empty future control.
- [BTC capture](../evidence/history-round2-btc-final.json): independent market with the same behavior.
- Published package: `src/unified/exchange.ts`, `fetchOHLCV` and the comparison in `fetchFundingRateHistory`; `src/candles.ts`, `getCandles` and `CandlesQuery`.
- [Pinned SDK package](https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1).
- Transaction hash: not applicable to a candle-range request; source rows retain `lastFillId` in the JSON. No trade was generated.

## Environment
SDK: `@somnia-chain/markets-sdk@0.32.1`; viem: `2.57.7`; Node.js: `24.11.1`; Windows; verified 2026-10-30 UTC+7.
Network: Somnia Tokyo testnet (Hideki), chain `50383`.
Indexer: `https://hideki-dev.smk.somnia.host/v1/graphql`.
ETH pool: `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`.
BTC pool: `0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0`.
Wallet address: not applicable; all operations are public reads without an account or signer.

## Suggested fix
Support an explicit ascending source selection from `ceil(since / 1000)` when `since` is present, scoped to the market before applying the limit. Preserve newest-N selection followed by ascending presentation when it is absent. Add a real-data or controlled-source regression with more than one page of candles: no cursor returns the latest page; an old cursor returns the first eligible page; subsequent pages cover all rows once; a future cursor returns empty. An alternative is to document newest-window semantics and expose separate bounded historical pagination.

For now, `client.getCandles` with explicit `from` and `to` over small bounded windows is a workaround. It still limits newest-first and sparse buckets must remain sparse; do not invent missing candles.

## Review status and duplicate risk
October 30 follow-up candidate prepared for the existing Feedback Build 50054. No matching candle-selection issue was found in six reviewed public participant indexes or the official bot-kit issue/PR titles. This issue is separate from report 04's millisecond-rounding bug: its root cause is newest-first source selection with post-limit filtering. The desired forward semantics are supported by the SDK's own comparison but should be confirmed by the maintainer; private submissions, a complete known-issues list, acceptance and payment remain unverified.
