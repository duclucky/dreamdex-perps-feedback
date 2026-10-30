# Guard misses positions on newly listed markets because its watch list never refreshes the registry
Severity: normal
Area: SDK

## Steps to reproduce
1. Use Node.js 24.11.1 and this repository's pinned `@somnia-chain/markets-sdk@0.32.1` dependencies. Run `node scripts/verify-guard-discovery.mjs` from the repository root. No key, wallet, funds or testnet setup is required.
2. The harness downloads and SHA-256 verifies the official guard, market, order and margin helpers at commit `4e75896896e024c03e2033d5920514f249998cd6`. It strips types and executes their actual bodies, detaching only the guard's final CLI `process.exit` invocation. It also runs the installed SDK's actual `SomniaMarkets.prototype.fetchPositions` method against controlled engine/registry adapters.
3. Model a successful initial discovery with only `ETH/USDso:USDso` in the healthy registry cache. Leave `PERP_SYMBOL` blank, the guard's all-held-markets mode. On the next controlled polling cycle, add a synthetic `NEW/USDso:USDso` market to the available registry and give the fixture account a position there. Do not reload the cache; its behavior matches the SDK's documented healthy-cache contract.
4. Keep the synthetic account's equity/maintenance ratio at 1.1, below the default 1.15 flatten threshold. Observe the guard's market selection, position-read trace, logs and close-boundary calls across two cycles.
5. Compare new exposure on an already cached market, both old/new exposure, an explicit registry-refresh control, and an already cached halted market. The refresh control changes only whether `exchange.loadMarkets(true)` is called between cycles.

## Expected
The guard's blank-symbol mode should discover held positions on a market listed after startup, rather than infer there are no positions from an indefinitely cached market set. Refresh discovery before enumerating positions at a documented bounded cadence, or use an authoritative account exposure list to discover unknown pools. Distinguish incomplete coverage from a confirmed empty account.

## Actual
`watchList` first calls `exchange.fetchPositions()`, then calls `perpMarkets(ctx.exchange, false, { includeHalted: true })`. Neither asks for a registry reload. SDK `fetchPositions` enumerates only its loaded swap markets after its implicit cached load. With a successful healthy discovery, ordinary loads return the existing registry; they are not periodic discovery refreshes. Consequently neither the position enumeration nor the helper's final intersection sees the newly listed pool.

Controlled-source result:

| Scenario | Guard behavior on the next cycle |
| --- | --- |
| Only the newly listed market has a position | Logs `no open positions to guard`; no margin-health check or close request |
| A new position appears on cached ETH | Detects ETH and calls the controlled flatten boundary |
| Positions on old ETH and new NEW | Checks/requests flatten only on ETH; NEW is absent |
| Explicit registry refresh before the next cycle | Detects NEW and calls the controlled flatten boundary |
| New position on a cached halted market | Still detects it, preserving the intended `includeHalted` behavior |

In the new-market-only case, the real SDK position method never even calls the fixture engine for the new pool before refresh. After one explicit reload, the unchanged `watchList` returns that market. Ordinary guard runs finish normally; there is no thrown cancellation or shutdown error.

Impact: a long-running guard can miss new-market exposure, including an account whose only position is on that market, until a registry reload or process restart occurs. For linked bots, re-granting permission in the app does not itself refresh this process's market cache; discovery and permission coverage are separate requirements. The harness uses the owner/read adapter path, so it does not demonstrate a live grant or delegated close.

This finding is conditional on healthy cached discovery, a listing after startup and no independent reload of the exchange. SDK retries after failed discovery can refresh the set; that recovery case is not asserted to be broken. No real market was deployed, real position opened, liquidation observed or financial loss demonstrated. Two controlled polling cycles prove the selection/dispatch defect; they are not a continuous production run. The SDK caching API itself is behaving as documented; this report concerns its use by the official bot example.

## Evidence
- [Reproducer](../scripts/verify-guard-discovery.mjs): 11 assertions across five controlled scenarios, with actual upstream guard/watch-list/helper logic and actual SDK position enumeration.
- [Captured output](../evidence/guard-discovery-round5.json): synthetic registry loads, per-pool read trace, selected symbols before/after refresh, health-check/close-boundary calls, logs and source hashes.
- [Official guard watch list](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-guard/src/index.ts#L71-L80): cached discovery and intersection with held symbols.
- [Official guard polling loop](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-guard/src/index.ts#L127-L140): reports an empty account without refreshing discovery.
- [Official market helper](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/packages/perp-core/src/markets.ts#L82-L96): forwards the explicit reload flag to `loadMarkets` and documents cache reuse.
- SDK npm package 0.32.1: shipped `src/unified/exchange.ts`, `loadMarkets` documentation and `fetchPositions` implementation. The script records the installed `dist/unified/exchange.js` SHA-256. The package is pinned by this repository's lockfile.
- Transaction hash: not applicable. There are zero RPC calls, signatures or transactions. `NEW` is an invented fixture symbol. The close function is a recording stub; a recorded flatten request is not a successful close or an onchain order.

## Environment
SDK: `@somnia-chain/markets-sdk@0.32.1`; viem: `2.57.7`; Node.js: `24.11.1`; Windows.
Bot-kit commit: `4e75896896e024c03e2033d5920514f249998cd6`, confirmed official main during this review.
Target product: official `perp-guard`, all-held-markets mode, intended for Somnia Tokyo testnet (chain `50383`). This reproduction is offline and does not connect to that network.
Wallet: none. The fixture uses dummy addresses and constructs no SDK client, transport, wallet or signer. Cached/available registry data, positions, health, timers, startup and close boundaries are controlled. The fixture registry adapter implements the documented successful-cache semantics; this is not a network/indexer simulation or a test of real discovery internals. Optional PnL state reads deliberately fail inside the SDK's supported degraded-position branch; both affected and control scenarios use that same condition.

## Suggested fix
Refresh discovery before calling `fetchPositions`, using a bounded refresh cadence or an authoritative account-exposure source that can resolve pools not already loaded. A reload only after the current `fetchPositions` result is insufficient for that same cycle, because the missing position was already filtered out. Keep halted markets eligible for protective monitoring.

When refreshing introduces a new market, re-check its trading-key permission coverage before attempting a delegated close and clearly report an uncovered position. Surface discovery failures/incomplete coverage rather than present a cached empty set as a guarantee of no exposure. Regression tests should include listings after startup, new positions on existing markets, old/new mixed exposure, halted held markets, permission changes and discovery failures. The supplied explicit-refresh control demonstrates discovery/dispatch only; it is not a production patch or proof of a successful close.

## Review status and duplicate risk
Follow-up candidate for the existing Feedback Build 50054. The user authorized publication and the update from seven to eight reports on October 30, 2026; organizer acceptance remains pending. Seven submitted report files remain unchanged. Six public participant indexes were refreshed and compared during this review; their contents were unchanged from the earlier screening. No matching new-listing/cache trigger was found in those indexes, official issue/PR titles or the session notes. This differs from the known no-account read-only guard issue, indexer mark staleness, missing trading-key reduce permission and report 07's cancellation-outcome handling. Private submissions and a complete organizer known-issues list remain unavailable; novelty, scope, severity and acceptance are for the organizer to decide.
