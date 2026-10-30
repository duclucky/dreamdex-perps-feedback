# Entry-margin preflight prevents restarting management of an existing position
Severity: normal
Area: SDK

## Steps to reproduce
1. Use the pinned repository dependencies with Node.js 24.11.1. Run `node scripts/verify-resume-preflight.mjs`. It requires the public Tokyo RPC to retain historical block `36620783`, but no wallet, private key or funds.
2. The script downloads six official bot-kit files at commit `4e75896896e024c03e2033d5920514f249998cd6`, verifies SHA-256 hashes, removes TypeScript types and redirects import seams. Eight child processes run the actual starter/funding CLI bodies, including their original `process.exit` calls. Their environments contain only controlled settings and Windows `SystemRoot`; no user `.env` is loaded.
3. For each strategy, give the controlled account an existing 0.004 ETH long and 5 USDso of unlocked collateral. Leave entry notional/leverage at defaults, 50 USDso and 2x, so the startup check requires 25 USDso. Permission checks succeed; no opening trade is needed to manage the held position.
4. Observe exit status and trace. Compare the same held position with 25 unlocked; then keep 5 unlocked and lower only the unused entry notional to 2. Both controls reach their existing-position close boundary. A flat account with only 5 remains an expected entry rejection.
5. Separately, at fixed Tokyo block `36620783`, read an actual public account's margin and ETH position, run the real `preflight` helper on those values, and compare the SDK's no-auto-pull reducing-order preview with a real owner `eth_call` simulation. Nothing is signed or broadcast.

## Expected
Opening a new position and resuming management of an existing one should have separate prerequisites. A starter that finds an existing position should be able to resume its watched exits without first funding the configured hypothetical next entry. A funding bot should be able to evaluate/exit its held position when opening is unaffordable. Preserve entry preflight for a genuinely flat account and all real permission, pricing, gas and close-validation requirements.

## Actual
Both strategies call `preflight` with `requiredUsdso: NOTIONAL / Math.max(1, LEVERAGE)` and immediately `process.exit(1)` on failure. This happens before starter's `existing = await positionIn(...)` branch, and before funding's first position/funding-management cycle.

Controlled results, observed through actual child-process exit codes:

| Account/configuration | Starter | Funding |
| --- | --- | --- |
| Held long, 5 unlocked, entry notional 50 at 2x | Exit 1; zero position reads/close calls | Exit 1; zero position reads/close calls |
| Same held long, 25 unlocked, entry notional 50 at 2x | Reaches watched stop-loss close boundary | Reaches carry-exit close boundary |
| Flat, 5 unlocked, entry notional 50 at 2x | Expected entry rejection | Expected entry rejection |
| Same held long, 5 unlocked, entry notional lowered to 2 at 2x | Reaches watched stop-loss close boundary | Reaches carry-exit close boundary |

No worker reaches an opening write. The successful management controls change only the unlocked amount or entry-notional setting; the held position remains identical. Their close boundary records a request and deliberately performs no trade, so it leaves the fixture position open. Its later upstream log about an open position is not an additional claimed bug.

Actual historical control, ETH at block `36620783`:

- Account holds **0.004 ETH long**; MarginBank status is `Healthy`.
- Unlocked collateral is **1.871847127890243945 USDso**. This is the bank's unlocked balance, not a claim about equity or withdrawable margin.
- Actual upstream `preflight` returns `ok: false`: it requires about **25 USDso to open its first position**, even though a position already exists.
- A same-block SDK preview of selling 0.004 ETH at **2256.25 USDso**, with `autoPull: false`, reports `increasingQuantity: 0`, full requested `reducingQuantity`, `lockAmount: 0` and `topUpRequired: 0`.
- The actual pool's corresponding owner `placeOrder` simulation returns `(true, orderId)`. This demonstrates acceptance of that reducing-order request in `eth_call`, not a mined fill or a completed full close.

Impact: restarting a bot can disable its management/exit logic solely because the account cannot fund a new configured entry that the existing-position path would never place. The error advises depositing or lowering notional, rather than explaining that protection/management never started. The report does not demonstrate liquidation, financial loss, a fresh live bot restart or a guaranteed exit under all market states.

The shared preflight's insufficient-entry check is not itself mathematically wrong. The issue is where the example strategies invoke it and terminate. This is separate from report 06's price change after sizing, the known wrong-side management of an existing position, and the known failure to reconcile changed onchain TP/SL settings. Here the existing position and configured side are both long, no old stops are armed, and execution stops before those branches.

## Evidence
- [Reproducer](../scripts/verify-resume-preflight.mjs): 14 assertions, comprising 10 controlled CLI checks across eight workers and four historical read/simulation checks.
- [Captured output](../evidence/resume-preflight-round6.json): worker exit codes, exact logs, position-read/entry/close traces, source hashes, actual margin/position, the no-auto-pull reducing quote and accepted simulation result.
- [Starter startup](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L84-L91) precedes [existing-position management](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L121-L125).
- [Funding startup](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-funding/src/index.ts#L80-L85) precedes [its management loop](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-funding/src/index.ts#L92-L131).
- [Shared preflight](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/packages/perp-core/src/margin.ts#L86-L157): checks unlocked collateral against the requested first-entry requirement.
- Transaction hash: not applicable. Worker order/close boundaries are controlled. Historical checks are reads and `eth_call`; the returned simulation order ID is not a mined transaction hash, persisted order or execution receipt.

## Environment
SDK: `@somnia-chain/markets-sdk@0.32.1`; viem: `2.57.7`; Node.js: `24.11.1`; Windows.
Bot-kit commit: `4e75896896e024c03e2033d5920514f249998cd6`.
Network: Somnia Tokyo testnet (Hideki), chain `50383`; historical block `36620783`.
RPC: `https://api.hideki2.infra.testnet.somnia.network`.
ETH pool: `0xd6cb1dd58580b84d76068ac21594219ce03aeddf`.
MarginBank: `0x478769e1177c0773c43a593dccc4ad15f15f1394`.
Public historical account: `0x3390B5CE917F61640DBb68FD1D86F45E483648AC`; no key or signer is used and its state is unchanged.

Worker startup/link checks, account/market/funding/price data, time, stop polling and close dispatch are fixtures. Actual preflight/margin, market, funding-conversion and position-selection helpers execute. The child CLI entry/exit logic is unmodified. The workers model linked-bot watched exits; they do not establish a real operator grant. The independent historical simulation is an owner call and does not prove delegated authority or that a newly installed bot can trade. SDK preview and actual contract simulation stay at the same block; archive RPC availability is required.

## Suggested fix
Resolve whether a position already exists before enforcing prerequisites specific to opening. For starter, resume existing-position protection without requiring collateral for a new entry or changing entry leverage as a side effect. For funding, allow position evaluation/exit while blocking new entries until entry preflight succeeds. Keep the empty/underfunded-flat-account check, and make any management-only mode explicit in logs.

Do not remove margin validation globally or blindly retry rejected orders. Preserve link/permission checks, gas availability, fresh position/pricing reads and the existing close checks. An existing position is not proof that every close will be accepted; resting-order capacity, liquidity and concurrent changes still matter. Add regression cases for restart with a healthy held position below the entry requirement, a flat underfunded account, funding reversal, both position sides, watched/registry exits and actual leverage differing from entry config. The controls establish branch ordering; no upstream patch or complete live protection guarantee is claimed.

## Review status and duplicate risk
Follow-up candidate for existing Feedback Build 50054. The user authorized publication and the update from eight to nine reports on October 30, 2026; organizer acceptance remains pending. The eight submitted reports remain unchanged. Reviewed the six public participant indexes refreshed in round 5, official issue/PR titles and session notes; no matching entry-preflight-before-existing-management trigger was found. Existing startup/TP-SL reports are distinguished above. Private submissions and a complete organizer known-issues list are unavailable, so novelty, scope, severity and acceptance remain for the organizer to determine.
