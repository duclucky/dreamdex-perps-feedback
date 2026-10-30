# Short starter swaps the configured take-profit and stop-loss percentages
Severity: normal
Area: SDK

## Steps to reproduce
1. With the pinned dependencies and Node.js 24.11.1, run `node scripts/verify-starter-short-thresholds.mjs`. This is an offline controlled-source test, not a live trading command. It downloads five official bot-kit files at commit `4e75896896e024c03e2033d5920514f249998cd6` and checks their hashes.
2. The actual `perp-starter` CLI runs in isolated workers with `PERP_SIDE=short`, `PERP_TAKE_PROFIT_PCT=2` and `PERP_STOP_LOSS_PCT=1`. Start flat, with no old stops, ample synthetic margin and an unchanged leverage setting. Entry succeeds in the fixture. The initial pool mark is 100; levels are intentionally compared with this mark, the strategy's own reference, rather than the entry fill price.
3. In owner mode, the actual `armBracket` helper and installed SDK construct the pair. Encode and decode the resulting `createLinkedPendingOrders` calldata, then inspect the GTE/LTE trigger prices and the helper's labels. Authorization is already true; the SDK writer boundary returns synthetic successful receipts.
4. With watched exits (`OWNER_ADDRESS` set in the fixture context), advance the mark to 101.5 for one management poll. In another worker, advance it to 98.5. Observe whether the actual close/placement helpers are invoked and which exit label the CLI prints.
5. Compare default long, custom short TP 4% / SL 0.5%, and equal-percentage short controls. Two diagnostic counterfactual workers change only the up/down percentage formulas; all other control flow and inputs remain the same.

## Expected
From reference mark `M`, each setting should retain its named purpose for both sides:

| Position | Take-profit | Stop-loss |
| --- | --- | --- |
| Long | `M × (1 + TP% / 100)` | `M × (1 − SL% / 100)` |
| Short | `M × (1 − TP% / 100)` | `M × (1 + SL% / 100)` |

For a short at reference mark 100 with TP 2% / SL 1%, the target is 98 and the stop is 101. A watched short at 101.5 should request its stop-loss close; at 98.5 it should still wait for the 2% profit target. Neither a stop nor a close request guarantees a fill or a maximum loss.

## Actual
The strategy computes `up` using `TAKE_PROFIT_PCT` and `down` using `STOP_LOSS_PCT` before choosing which level is the TP or SL. For shorts it changes the level names but does not change the percentages:

```ts
const up = BigInt(Math.round(mark * (1 + TAKE_PROFIT_PCT / 100) * 1e18));
const down = BigInt(Math.round(mark * (1 - STOP_LOSS_PCT / 100) * 1e18));
const takeProfit = SIDE === "long" ? up : down;
const stopLoss = SIDE === "long" ? down : up;
```

| Controlled case, reference mark 100 | Expected TP / SL | Actual TP / SL |
| --- | --- | --- |
| Short TP 2%, SL 1% | 98 / 101 | **99 / 102** |
| Short TP 4%, SL 0.5% | 96 / 100.5 | **99.5 / 104** |
| Long TP 2%, SL 1% | 102 / 99 | 102 / 99 |
| Short TP 1%, SL 1% | 99 / 101 | 99 / 101 |

The short owner pair really encodes the wrong levels: the buy-to-close GTE stop-loss has price 102 and the LTE take-profit has price 99. Both retain the correct whole-position sentinel, side and trigger operators. This is not an SDK ID-order mix-up or a reversed position side. The startup log still advertises TP 2% / SL 1%, followed by the helper's armed-level log of TP 99 / SL 102.

The same levels drive watched exits. At 101.5, the default short makes **no close request** and retains its synthetic position, despite crossing the configured 1% stop. At 98.5, it instead requests and receives a **synthetic** take-profit close before the configured 2% target. Long and equal-percentage controls close as expected. Changing only the percentage formulas restores the short stop at 101 and profit target at 98 in both counterfactual decision cases.

Impact: unequal TP/SL settings have reversed percentage distances for shorts in both protection paths. The default stop distance from the reference mark is doubled; the 4%/0.5% example uses an eight-times-wider stop distance and an eight-times-smaller target distance. These are price distances, not measurements of losses, execution quality or risk guarantees. Equal percentages conceal the defect.

## Evidence
- [Reproducer](../scripts/verify-starter-short-thresholds.mjs): 18 assertions across ten actual CLI workers, including two arithmetic-only counterfactuals.
- [Captured results](../evidence/starter-short-thresholds-round9.json): exact configuration, CLI output, exit codes, encoded/decoded pair tuples, synthetic order/position traces and source hashes.
- [Official level construction](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L179-L185) feeds both [registry setup](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L189-L197) and [watched exit decisions](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L226-L232).
- [Official defaults](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/.env.example#L150-L154) list TP 2% and SL 1%; the [starter README](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/README.md) supports long/short and names the settings independently.
- Transaction hash: not applicable. All addresses, hashes, receipts and fills inside workers are fixtures; no transaction was sent. Only pinned public source downloads use the network.

## Environment
Bot-kit commit `4e75896896e024c03e2033d5920514f249998cd6`; Markets SDK `0.32.1`; viem `2.57.7`; Node.js `24.11.1`; Windows.

Target: official ETH-PERP example intended for Tokyo/Hideki `50383`, exercised offline. Actual starter, market/margin/order/stop helpers and SDK stop-call construction/receipt decoding run. Synthetic boundaries supply account, mark, book, sizing ceiling, receipts, operator authorization and time. Startup `.env` loading is disabled; no key, signer or RPC client is constructed. Close fills are synthetic dispatch evidence, not onchain outcomes. The watched branch is selected by the owner configuration; delegated transaction authorization is not tested. One bounded poll intentionally ends each worker; shutdown behavior is not the reported defect.

## Suggested fix
Choose the percentage by its purpose before constructing each directional level. For example, compute `takeProfit` directly with `SIDE === "long" ? 1 + TP/100 : 1 − TP/100`, and `stopLoss` with the corresponding SL expressions, then preserve the existing raw-unit conversion and tick alignment. Do not swap the meaning of the environment variables or require equal percentages as a workaround.

Add unequal-percentage regression cases for both sides and both exit modes, checking encoded trigger terms and decisions just beyond the configured thresholds. The included counterfactual is diagnostic; no upstream fix is applied.

## Review status and duplicate risk
Follow-up report 12 for existing Build 50054. The user explicitly authorized publication and the update from eleven to twelve reports on October 31, 2026; organizer acceptance remains pending. Six public participant indexes and 53 official bot-kit issue/PR titles were refreshed. No matching short-percentage swap was found in the reviewed material; private submissions and the complete organizer list are unavailable. This starts flat with the configured side, no old bracket and successful setup, distinguishing it from existing-position side handling, changed-bracket restart reports and report 11's setup-failure exit. Proposed normal severity and acceptance remain for organizer review.
