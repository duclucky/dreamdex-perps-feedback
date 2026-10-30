# Maker forgets live quote IDs after cancellation failure and reports clean shutdown
Severity: normal
Area: SDK

## Steps to reproduce
1. Use the repository's pinned dependencies with Node.js 24.11.1. Run `node scripts/verify-maker-cancel.mjs` from the repository root. No wallet, key, environment file or testnet funds are required.
2. The harness downloads three official bot-kit files at commit `25798660bbe4674a6f83a960b202852896e2fed4`, verifies their SHA-256 hashes and strips TypeScript types. It executes the actual maker `main` and actual market/order helper bodies, redirecting imports to controlled exchange/startup/timer fixtures. The CLI's final `process.exit` invocation is detached so the test can await `main`.
3. Let the maker place a synthetic bid and ask, IDs `1` and `2`. Advance the synthetic mark from 100 to 101, exceeding the default 8 bps re-quote threshold. The fixture supplies sufficient sizing capacity for replacement quotes.
4. Make `trader.cancelOrder` throw the SDK's `RpcError` for those original IDs while leaving them in the fixture's open-order Map. Placement remains available. Run the next cycle and then request ordinary shutdown through the controlled stop predicate.
5. Compare healthy cancellation, one failed cancellation, shutdown-only failure, and an already-filled race. In the race control the fixture removes each original order before throwing `ContractRevertError(IncorrectOrder)`.

## Expected
An unresolved cancellation must not be treated as proof that an order disappeared. The maker should retain unresolved IDs and reconcile their status before replacing the affected quotes. Shutdown should distinguish confirmed cleanup from unresolved live orders and provide actionable order IDs rather than claim that all quotes were pulled.

## Actual
The shared `cancelQuietly` catches every cancellation error, logs it and resolves without an outcome. The maker awaits this helper for its old quotes, clears `resting`, and places replacements regardless of whether cancellation succeeded. Shutdown considers only the newest `resting` IDs. It then unconditionally logs `quotes pulled, exiting` and completes normally.

Observed controlled-source results:

| Scenario | Peak synthetic open orders | Synthetic IDs still open at exit | Replacement placements |
| --- | --- | --- | --- |
| Healthy cancellation | 2 | none | 2 |
| Both original cancellations fail | 4 | 1, 2 | 2 |
| Only original ID 1 fails | 3 | 1 | 2 |
| Both shutdown cancellations fail | 2 | 1, 2 | 0 |
| Original orders already filled before cancellation | 2 | none | 2 |

In the two-failure re-quote case each original ID has exactly one cancellation attempt. The final cleanup cancels only IDs `3` and `4`; IDs `1` and `2` are never retried. Both the re-quote failure and shutdown-only failure still produce the clean-exit message. These are two consequences of the same missing cancellation-outcome handling, submitted as one report.

Impact: if a real cancellation fails while a quote remains open, that quote can become untracked by this strategy and survive its normal cleanup. With sufficient available margin, replacement quotes can coexist with unresolved originals. This establishes a deterministic control-flow defect under the injected failure condition; it does not establish how frequently a public RPC fails, that a particular real cancellation failed, a mined orphan order, an actual fill, a financial loss or a contract exploit. Real SDK sizing may constrain replacements; the harness deliberately supplies spare capacity to isolate cancellation handling.

## Evidence
- [Reproducer](../scripts/verify-maker-cancel.mjs): 12 assertions across five controlled scenarios, retaining upstream cancellation and maker logic.
- [Captured output](../evidence/maker-cancel-round4.json): per-scenario cancellation attempts, failures, placements, open IDs, logs, source hashes and explicit synthetic-state markers.
- [Official cancellation helper](https://github.com/somnia-chain/dreamdex-bot-kit/blob/25798660bbe4674a6f83a960b202852896e2fed4/packages/perp-core/src/orders.ts#L203-L219): unconditional catch and no structured result.
- [Official maker re-quote path](https://github.com/somnia-chain/dreamdex-bot-kit/blob/25798660bbe4674a6f83a960b202852896e2fed4/strategies/perp-maker/src/index.ts#L129-L134): clears old IDs after awaited cancellation calls.
- [Official maker shutdown](https://github.com/somnia-chain/dreamdex-bot-kit/blob/25798660bbe4674a6f83a960b202852896e2fed4/strategies/perp-maker/src/index.ts#L189-L197): attempts only current tracked IDs, then reports cleanup.
- Transaction hash: not applicable. Every order ID, receipt, fill response, price, capacity result and order-state transition in this reproduction is synthetic. There are zero RPC calls, signatures or transactions. The only network requests download hash-pinned source from GitHub.

## Environment
SDK: `@somnia-chain/markets-sdk@0.32.1`; viem: `2.57.7`; Node.js: `24.11.1`; Windows.
Bot-kit commit: `25798660bbe4674a6f83a960b202852896e2fed4`.
Target product: official `perp-maker` and `perp-core` examples for Somnia Tokyo testnet, chain `50383`. This particular reproduction is offline; it does not connect to that network.
Wallet: none. The addresses in the fixture are dummy identifiers, not accounts inspected or controlled by this investigation. `ctx.config.dryRun: false` selects the helper's fixture-backed placement/cancellation branch; it does not create a real signer or send an order. Startup authorization, leverage, sizing capacity, positions and time are controlled, not integration-tested. SDK error classes are real; injected cancellation failures are controlled.

## Suggested fix
Return an explicit cancellation outcome, separating confirmed cancellation, confirmed absence and unresolved failure. A transport error alone cannot establish that the order is absent. Retain all unresolved IDs and reconcile using authoritative order state; do not replace an affected quote while its prior state is unresolved. Apply bounded retry/backoff and make pending cleanup visible and recoverable across process restarts.

During shutdown, attempt cleanup of all tracked and pending IDs and report any unresolved IDs. Only claim that quotes were pulled after confirmation. Merely rethrowing an unexpected error may stop replacement placement, but does not by itself reconcile or clean up the original orders and is not a complete shutdown fix.

Regression coverage should include healthy cancellation, one/both old cancellations failing, ambiguous transport outcomes where cancellation actually succeeded, a genuinely filled/expired order, failed shutdown cleanup and recovery after restart. The supplied healthy and already-filled controls show why benign missing-order races must remain distinct from unresolved failures. No upstream or product fix is claimed here.

## Review status and duplicate risk
Follow-up candidate for the existing Feedback Build 50054. The user authorized publication and the update from six to seven reports on October 30, 2026; organizer acceptance remains pending. The six submitted report files are unchanged. Reviewed public indexes and session known-gotcha notes contain maker position-cap, skipped-quote retry and interrupted-shutdown findings, which have different triggers. One public maker report explicitly leaves cancellations that fail outside its two demonstrated claims. This report instead reproduces ordinary re-quote/shutdown control flow after a cancellation helper swallows an injected failure. Private reports and a complete organizer known-issues list are unavailable, so novelty, scope, severity, eligibility and rewards remain subject to organizer review.
