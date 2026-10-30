# Starter exits with an unprotected position when post-entry TP/SL setup fails
Severity: normal
Area: SDK

## Steps to reproduce
1. With the pinned dependencies and Node.js 24.11.1, run `node scripts/verify-starter-protection-failure.mjs`. This is a controlled offline execution, not a live trading command. It downloads five official bot-kit sources at commit `4e75896896e024c03e2033d5920514f249998cd6` and verifies their hashes.
2. The actual `perp-starter` CLI and its margin, market, sizing, placement and stop helpers run in six isolated workers. Imports are redirected to fixture startup/account/transport/time boundaries; original strategy control flow and process exit remain intact. No user `.env`, key or signer is read.
3. Begin flat in owner mode (`OWNER_ADDRESS` absent), with sufficient synthetic margin, unchanged 2x leverage, no existing stops and an otherwise successful synthetic 0.004 ETH entry. The SDK's actual stop-placement code builds a linked TP/SL pair with an operator registry explicitly supplied and authorization already true.
4. In the first failing case, the writer fixture has 0.10 native units but the encoded pair requires 0.30. It rejects before broadcast. In the second, the fixture has 0.50 but injects a one-time `RpcError` before broadcast. Observe exit code, residual synthetic position, pending stops and management/recovery trace.
5. Compare funded successful setup, dry run and rejected-entry controls. A separate bounded-retry counterfactual retries only the explicitly pre-broadcast fixture failure and demonstrates that the same transient fault can recover. This counterfactual is not an upstream patch or a safe production retry policy.

## Expected
A bot presented as opening one bracketed position should handle entry success followed by protection-setup failure as a distinct operational state. Check predictable stop-deposit/gas prerequisites before adding exposure; once exposure exists, retain an explicit management/recovery path or actionable exposure warning rather than ending at a generic setup error before management starts.

These transactions are separate, so atomic protection is not assumed. Recovery must reconcile actual pending transactions and stops before retrying, and any fallback close policy needs an explicit user choice. No guaranteed exit or automatic rollback is requested.

## Actual
Owner-mode startup prints the per-stop cost, then calls `placePerp` and awaits a filled entry. Later it awaits `armBracket` outside any recovery boundary. A rejected stop-placement promise reaches the CLI's top-level error handler, which prints the error and exits 1. The monitoring loop is below that await and never starts.

| Controlled scenario | Entry calls | Stop attempts | Management polls | Outcome |
| --- | --- | --- | --- | --- |
| Entry succeeds; insufficient stop deposit | 1 | 1 | 0 | Exit 1; 0.004 ETH remains, no stops |
| Entry succeeds; one-time pre-broadcast stop RPC error | 1 | 1 | 0 | Exit 1; 0.004 ETH remains, no stops |
| Funded successful setup | 1 | 1 | 1 | Pair IDs decoded; synthetic trigger/flat observation; clean exit |
| Dry run with low native balance | 0 | 0 | 0 | No synthetic exposure or writes |
| Entry rejected before execution | 1 | 0 | 0 | No synthetic exposure |
| Counterfactual recovery of the same one-time stop error | 1 | 2 | 1 | One retry, then protected management path |

In both failing cases there are zero fallback-close requests and zero calls to the normal shutdown helper. The last successful action is the fixture's confirmed entry. The error output explains the failed stop request but does not explicitly summarize the remaining exposure or say that protection and management never started. Even an adequately funded configuration exits on the transient stop error.

Impact: a partial startup failure can leave the newly opened position without either registry stops or a running bot watching exits. These tests demonstrate control flow and residual **synthetic** state, not a mined unprotected position, actual financial loss or incident frequency. The README already discloses the native deposit requirement; the issue is proceeding through entry and terminating without post-entry recovery, not that the deposit exists.

## Evidence
- [Reproducer](../scripts/verify-starter-protection-failure.mjs): 14 assertions across six isolated CLI scenarios.
- [Captured results](../evidence/starter-protection-failure-round8.json): exit codes, stdout/stderr, ordered entry/stop/poll traces, synthetic residual positions, encoded 0.30 pair value, decoded fixture stop IDs and source hashes.
- [Actual entry call](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L146) precedes [bracket setup and the monitoring loop](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/src/index.ts#L179-L199).
- [Actual armBracket helper](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/packages/perp-core/src/stops.ts#L54): its failed SDK promise is not recovered before returning to the strategy.
- [README](https://github.com/somnia-chain/dreamdex-bot-kit/blob/4e75896896e024c03e2033d5920514f249998cd6/strategies/perp-starter/README.md) describes a bracketed position and the native stop deposit. The harness does not treat either statement as a guarantee of transaction atomicity.
- Transaction hash: not applicable. Hashes and receipts inside workers are clearly synthetic fixtures; no transaction was sent. Only public source downloads use the network.

## Environment
Bot-kit commit `4e75896896e024c03e2033d5920514f249998cd6`; Markets SDK `0.32.1`; viem `2.57.7`; Node.js `24.11.1`; Windows.
Target: official owner-mode ETH-PERP example for Tokyo/Hideki `50383`, exercised offline with fixture addresses and balances. No real wallet or RPC endpoint is used.

Actual strategy/helper bodies and installed SDK stop-call construction/receipt decoder execute. Margin/position/book data, startup link check, stop-price feed, transport, native budget, entry/stop receipts and time are fixtures. The successful control's trigger is a fixture that makes the position flat; it does not prove a real trigger filled. The 0.10 balance is a test input, not a quote for actual entry gas. The RPC failure is explicitly pre-broadcast; unknown transaction outcomes are not modeled. Operator approval is already true to exclude the known missing-registry/grant setup issues.

## Suggested fix
Before entering, validate the required native stop deposits plus a gas reserve for the intended workflow and validate bracket terms. Preserve margin sizing and trading permissions.

After a confirmed or partially filled entry, track protection setup separately from entry. On failure, re-read the position and reconcile stop/transaction status, then use a bounded, documented recovery policy. Do not blindly resubmit after an unknown transaction outcome or assume a close will fill. If safe recovery cannot proceed, explicitly report the held amount and absence of protection and retain monitoring where possible. Add regression cases for stop rejection after entry, a recoverable transport fault, dry run, failed entry and partial fills.

## Review status and duplicate risk
Follow-up candidate 11 for existing Build 50054. The user explicitly authorized publication and the update from ten to eleven reports on October 31, 2026; organizer acceptance remains pending. Six public participant indexes and 53 current official bot-kit issue/PR titles were refreshed; no matching post-entry protection-setup failure was found. This differs from report 09's pre-entry startup requirement, existing wrong-side or changed-bracket restart reports, and Ctrl-C cleanup failures: the account starts flat, startup checks pass, no old bracket or signal exists, and failure occurs after entry. Private submissions and the full organizer list remain unavailable. Normal severity and acceptance remain for organizer review.
