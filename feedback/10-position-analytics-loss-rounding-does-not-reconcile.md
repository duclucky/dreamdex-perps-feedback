# Position analytics undercount fractional losses and fail exact equity reconciliation
Severity: normal
Area: SDK

The discrepancy is **one collateral wei per affected position** (`0.000000000000000001 USDso`). This is a low-impact exact-accounting/documentation defect, not evidence of material trading loss, an exploit or an incorrect liquidation decision.

## Steps to reproduce
1. Install the pinned dependencies and run `node scripts/verify-analytics-rounding.mjs` with Node.js 24.11.1. The public Tokyo RPC must retain block `37225356`. No account credentials or signer are required.
2. At that block, read `getAccountState`, `getAccountHealth` and `getAccountEquity` directly from MarginBank for the eight public accounts in the script. Each has exactly one active pool, a nonzero position and zero accrued funding in this snapshot. These conditions isolate position PnL from other positions and funding.
3. Run the actual installed SDK `getPerpPositionAnalytics` reader. Its head supplier returns the replay block; its implementation, ABI and contract reads remain unchanged. Compare `unlockedCollateralBalance + equityContribution` with the two agreeing contract equity getters.
4. Compare five fractional-loss shorts on BNB, AVAX, SOL and NEAR with three controls: profitable ETH short, profitable NEAR long and exactly divisible BTC long loss. Obtain the base scale from the pool's own health snapshot.
5. As a counterfactual, replace only the PnL division's truncation with signed floor, retaining the same raw position/price/funding inputs. Finally, repeat the sum with actual `listPerpPositionAnalytics` for a public account holding positions across 21 active pools.

## Expected
Per-position analytics advertised as an exact port of the deployed bank should reconstruct its equity and margin requirements at a common block. If the deployment intentionally uses a different rounding convention, the SDK should expose that distinction and qualify its exact-reconciliation claim.

Profitable positions and exactly divisible losses should retain their current results. Funding rounding and margin rounding have separate rules and should not be changed indiscriminately.

## Actual
`perpPositionAnalytics` computes:

```ts
const unrealizedPnl = ((markPrice - avgEntryPrice) * size) / oneBase;
```

JavaScript bigint division truncates toward zero. For a negative, inexact quotient, this makes the loss one raw collateral unit smaller than signed floor. The SDK source and shipped Perps guide explicitly describe truncation as matching the protocol and describe exact equity reconstruction; the observed Tokyo deployment disagrees in the isolated cases below.

| Real snapshot at block 37225356 | Accounts | SDK-reconstructed equity minus contract equity |
| --- | --- | --- |
| Fractional-loss shorts: BNB, AVAX, SOL, NEAR | 5 | +1 wei each |
| Profitable ETH short / profitable NEAR long | 2 | 0 |
| Exactly divisible BTC long loss | 1 | 0 |
| Account with 21 active pools | 1 | +2 wei total |

All eight single-pool accounts have zero accrued funding. Both direct contract equity getters agree. Their three SDK margin requirements already match the bank exactly. Changing only the PnL quotient to floor restores exact equity in all five discrepant cases and leaves the controls unchanged. In the 21-pool account, exactly two fractional-loss rows differ by one wei; correcting those rows restores the bank equity while retaining all funding contributions.

For example, the BNB account `0xc8e6ba18fd99cf251c3fb97a2202968b4c186fc0` has SDK `unrealizedPnl = -37542536881737735738`, whereas its contract equity less unlocked collateral is `-37542536881737735739`. This is an actual historical read, not a mocked bank or an injected position.

Impact is limited to exact bigint reconciliation: a consumer following the guide can fail a strict equity identity or report losses one unit light. Ordinary rounded USD displays will normally hide this amount. No material balance loss, threshold crossing, execution rejection or liquidation caused by this discrepancy has been demonstrated. Findings about generic floating-point display accuracy are outside this report.

## Evidence
- [Reproducer](../scripts/verify-analytics-rounding.mjs): 28 assertions across eight isolated single-pool cases and one 21-pool case. Passing means the discrepancy and controls reproduced; the SDK has not been patched.
- [Captured raw reads and results](../evidence/analytics-rounding-round7.json): same-block account state, agreeing equity getters, exact metrics, pool snapshots, signed numerators/base scales, counterfactuals and SDK source hashes.
- Published package: [`@somnia-chain/markets-sdk@0.32.1`](https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1). Relevant shipped files: `src/perp/margin.ts`, particularly `perpPositionAnalytics`, and `docs/PERPS.md`'s per-position analytics description. The installed executable files are used directly by the reproduction.
- [SDK Perps guide](https://prd.smk.somnia.host/docs/typescript/perps): per-position analytics and exact reconstruction description; the pinned package contains the same relevant claims.
- Transaction hash: not applicable. These are archive `eth_call` reads of existing public states; no transaction is created, signed, broadcast or persisted.

## Environment
SDK `0.32.1`; viem `2.57.7`; Node.js `24.11.1`; Windows.
Network: Somnia Tokyo/Hideki testnet, chain `50383`; replay block `37225356`.
RPC: `https://api.hideki2.infra.testnet.somnia.network`.
MarginBank: `0x478769e1177c0773c43a593dccc4ad15f15f1394`.
Collateral: USDso, 18 decimals.

All account addresses, pools and raw inputs are recorded in the script/output. The SDK head function is pinned to a historical block so SDK and direct reads describe one state. No economic data, arithmetic function, contract response or account state is mocked. The counterfactual floor is local arithmetic only. Archive availability and deployment version matter; this does not establish behavior on all chains or future upgrades.

## Suggested fix
Confirm the deployed bank implementation/version responsible for these snapshots, then align analytics PnL rounding with that implementation and update the guide's incompatible truncation/exactness statements. The floor-only counterfactual is sufficient for the captured cases, not a reviewed patch for every related preview function.

Add same-block reconciliation coverage with negative PnL whose numerator is not divisible by `oneBase`, plus exact-loss, profitable-long/short and nonzero-funding controls. Audit dependent equity projections separately. Do not replace every signed division or funding ceiling globally.

## Review status and duplicate risk
Follow-up candidate for Build 50054. The user explicitly authorized publication and the update from nine to ten reports on October 31, 2026; organizer acceptance remains pending. The nine prior reports remain unchanged. Six public participant repository heads and all current official bot-kit issue/PR titles were refreshed on October 30; no matching analytics-loss-rounding/reconciliation report was found in the reviewed indexes. The complete organizer list and private submissions are unavailable, so novelty and acceptance are unconfirmed. Proposed normal severity reflects the smallest available category; observed economic magnitude is explicitly tiny.
