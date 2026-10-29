# Bot-kit applies IOC slippage after sizing and turns an affordable quantity into a margin rejection
Severity: normal
Area: SDK

## Steps to reproduce
1. Use Node.js 24.11.1 and the pinned `@somnia-chain/markets-sdk@0.32.1` dependencies in this repository. Run `node scripts/verify-botkit-sizing.mjs`.
2. The harness downloads the official kit's reviewed `orders.ts` and `markets.ts` at commit `25798660bbe4674a6f83a960b202852896e2fed4`, verifies their SHA-256 hashes, removes TypeScript types and executes their actual helper bodies. Only import seams are redirected. It never loads a key or creates a wallet client.
3. At fixed Tokyo block `36620783`, ask the real `sizeOrder` helper to cap a large ETH request at the best opposite price. Its SDK max-size read and all contract simulations are pinned to that block.
4. Pass its accepted quantity and original price to `placePerp` with `ORDER_TYPE.MARKET` and default slippage, matching the size-then-place composition in `perp-starter` and `perp-funding`. The trader boundary is replaced with a real `eth_call` simulation, not a broadcast.
5. Compare two controls: send the original-price quantity with `slippageBps: 0`; then calculate size at the final adjusted price and pass that final price with `slippageBps: 0` to avoid applying slippage twice. The harness checks both long and short orders.

## Expected
Sizing should use exactly the same aligned limit price that placement will send. If slippage makes the original quantity unaffordable, the composed helper path should resize or skip before reaching the rejected placement. A shared final-price preparation step should prevent the sizing and placement paths from disagreeing deterministically.

## Actual
`sizeOrder` forwards the original price to `getMaxPerpOrderSize`. Afterwards, `placePerp` defaults MARKET/FOK slippage to 20 bps, adjusts the price and aligns it to the tick grid. The quantity is left unchanged. The higher adverse entry gap raises the margin required for that quantity.

Pinned real-data result (ETH, block 36620783):

| Side | Original price | Accepted original size | Final helper price | Same-size final-price eth_call | Resized at final price |
| --- | --- | --- | --- | --- | --- |
| Buy/long | 2262.83 | 0.0075 ETH | 2267.35 | `InsufficientMarginForOrder` | 0.0072 ETH; succeeds in eth_call |
| Sell/short | 2260.78 | 0.0115 ETH | 2256.25 | `InsufficientMarginForOrder` | 0.0112 ETH; succeeds in eth_call |

The original-price control succeeds for both sides. The final-price same-quantity SDK preview reports `meetsInitialMargin: false` and `sufficient: false`, consistent with the pool's named revert. Recomputing at the final price lowers size and passes both the SDK margin preview and the actual contract simulation.

All these calls use the same historical block, so this observation does not depend on mark movement, block drift, competing orders or a read-after-write race. It is also different from the existing report that max size ignores resting same-side orders: the SDK returns the correct size for the price it was actually given here; the caller changes that price afterwards.

Impact: near the margin ceiling, the kit's size-then-send flow can reject an order it just sized as affordable. `placePerp` handles ordinary IOC-no-fill/post-only errors, but rethrows the margin rejection; affected example strategies can then terminate through their top-level error handler. This report establishes the helper composition and rejection, not a full live strategy crash, a mined failed transaction, gas loss or a profitable strategy.

## Evidence
- [Reproducer](../scripts/verify-botkit-sizing.mjs): 14 checks, seven per side, using the actual upstream sizing/placement/price-alignment bodies with guarded transaction boundaries.
- [Captured output](../evidence/botkit-sizing-round3.json): exact prices, raw quantities, block, SDK quotes, named reverts, four successful control simulations, source hashes and explicit fixture disclosure.
- [Official orders helper at the tested commit](https://github.com/somnia-chain/dreamdex-bot-kit/blob/25798660bbe4674a6f83a960b202852896e2fed4/packages/perp-core/src/orders.ts): `sizeOrder` and `placePerp`.
- [Official starter](https://github.com/somnia-chain/dreamdex-bot-kit/blob/25798660bbe4674a6f83a960b202852896e2fed4/strategies/perp-starter/src/index.ts) and [funding example](https://github.com/somnia-chain/dreamdex-bot-kit/blob/25798660bbe4674a6f83a960b202852896e2fed4/strategies/perp-funding/src/index.ts): size with the touch, then place MARKET without preparing its adjusted price first.
- Transaction hash: not applicable; all contract checks are `eth_call`, with no signature or state change. The mock success wrapper lets the helper finish logging; its `sent: true` and empty `fills` are **not** mined execution evidence.

## Environment
SDK: `@somnia-chain/markets-sdk@0.32.1`; viem: `2.57.7`; Node.js: `24.11.1`; Windows.
Bot-kit commit: `25798660bbe4674a6f83a960b202852896e2fed4`.
Network: Somnia Tokyo testnet (Hideki), chain `50383`.
RPC: `https://api.hideki2.infra.testnet.somnia.network`.
ETH pool: `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`.
Public test account read/simulated: `0x3390B5CE917F61640DBb68FD1D86F45E483648AC`; an existing account with a 0.004 ETH long at the pinned block. No key is used and its onchain state is unchanged. The sell case includes a flip, not merely reducing the existing long.
This harness tests owner-call margin gating. It does not prove an operator-granted live trade or a fresh empty-account onboarding journey. The `sizeOrder` call uses `autoPull: false`; a trading-key path likewise disables auto-pull, and owner auto-pull can change the relevant capacity.

## Suggested fix
Compute the final tick-aligned crossing price once, before `sizeOrder`. Size at that price and pass the prepared price through placement without another slippage adjustment. Prefer a shared prepare/size/place object rather than duplicating arithmetic in strategies. Keep the raw user price and resulting bound visible so price limits remain auditable.

Add regression cases for both sides near the IM ceiling, a small quantity with spare margin, explicit zero slippage, FOK/IOC, tick boundaries, below-minimum results, and an owner auto-pull versus delegated no-auto-pull path. Do not fix this by blindly retrying after the contract rejects or by sending an unbounded price. The smaller final-price controls in this report demonstrate the sizing correction, not a patch to all strategy call sites.

## Review status and duplicate risk
October 30 follow-up candidate prepared for the existing Feedback Build 50054. Prior five report files remain unchanged; acceptance of every item is still subject to organizer review. Six public participant indexes, the session's known-gotcha slides and public bot-kit issue/PR titles were screened; no matching size-before-slippage trigger was found. Known decimal scaling, IOC-touch, gas-floor, max-position/resting-order and read-after-write findings are separate. Private submissions and a complete organizer known-issues list remain inaccessible. Eligibility of bot-kit issues, novelty, severity and any reward are for the organizer to decide.
