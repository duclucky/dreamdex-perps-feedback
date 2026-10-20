# Perps guide recommends singleton watch support and later says the SDK does not subscribe to either singleton
Severity: normal
Area: docs

## Steps to reproduce
1. Open the official Perps SDK guide linked below, or read `docs/PERPS.md` from the pinned 0.32.1 package.
2. Compare the section about watching the perp plane with the later raw-event ABI section.
3. Run `npm run verify` to acquire `client.watchPerpMarkets()` and read its hydrated funding-payment and liquidation windows without a signer.

## Expected
The guide should distinguish `watchMarket(pool)`, which watches pool-level order/funding-rate events, from `watchPerpMarkets()`, which owns the singleton funding-settlement/liquidation plane. The raw-event section should describe raw watches as an alternative where appropriate rather than imply that the singleton SDK watch is absent.

## Actual
One section documents `watchPerpMarkets()` as the singleton plane with snapshot/live behavior. A later paragraph claims the SDK's live tail lacks both singleton subscriptions. The stale paragraph implies that funding settlement and liquidation monitoring require manual raw-event watches, contradicting the earlier supported path.

The shipped 0.32.1 SDK successfully acquired the plane and returned three liquidation rows and three funding-payment rows during this reproduction. The verification establishes acquisition and hydration only; it does not claim to have observed a newly mined event during the short check. `src/perp/plane.ts` contains the implementation.

## Evidence
- `evidence/candidate-verification.json`: watch acquisition, hydrated row counts and IDs.
- `scripts/verify-candidates.mjs`: read-only acquisition and cleanup.
- Installed `docs/PERPS.md`: section around line 984 and paragraph at line 1186.
- [Official live guide](https://somnia-platform-docs.vercel.app/markets/somnia-markets/typescript/perps): both statements observed on 2026-10-20.
- [Pinned npm package](https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1).

## Environment
SDK: 0.32.1; viem: 2.57.7; Node.js: 24.11.1; Windows.
Network: Somnia Hideki testnet, chain 50383 (Tokyo/DreamDEX region).
RPC WebSocket: `wss://api.hideki2.infra.testnet.somnia.network/ws`.
Indexer: `https://hideki-dev.smk.somnia.host/v1/graphql`.
Wallet address: not applicable; no wallet or signer used.

## Review status and duplicate risk
Feedback submission candidate, proposed normal severity. The inconsistency was not listed in the two public participant indexes inspected. Private/unpublished reports and organizer acceptance were not accessible. This report requests a documentation correction, not an SDK implementation change.
