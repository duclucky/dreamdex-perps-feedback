# PerpStateOnchain.fundingRate documentation labels a calculation-window rate as a settlement-window rate
Severity: normal
Area: docs

## Steps to reproduce
1. Install dependencies and run `npm run verify`.
2. Read the published `PerpStateOnchain.fundingRate` comment in `dist/perp/state.d.ts:24` (SDK 0.32.1).
3. Compare it with `fundingWindowSec` in the same declaration and the normalization guidance in `docs/PERPS.md` and `src/funding.ts`.
4. Read BTC via `client.getPerpState(pool)` and compare the calculation window with the settlement interval.

## Expected
The property comment shown in editor tooltips should identify the rate as a fraction per `fundingWindowSec` calculation window. It should instruct consumers to normalize before treating it as the amount for one settlement interval.

## Actual
The `fundingRate` property comment describes a settlement-window rate. The same declaration's `fundingWindowSec` comment and the perps guide identify the calculation-window basis instead. The live BTC read uses a 28,800-second calculation window and a 3,600-second settlement interval.

At verification, raw fundingRate was `1766891057335065`; the SDK helper returned `220861382166883` per interval, matching integer division by eight. A consumer who interprets the misleading property tooltip as an hourly amount can overstate the interval funding rate by about eight times. This is a documentation inconsistency; the normalization helper itself produced the correct result. No account funding charge was generated or claimed.

## Evidence
- `evidence/candidate-verification.json`: property-text assertions, live funding parameters and normalized value.
- `scripts/verify-candidates.mjs`: read-only reproducer.
- Installed package: `dist/perp/state.d.ts:24`, `src/perp/state.ts:37`, `docs/PERPS.md:14`, `src/funding.ts`.
- [Official perps SDK guide](https://somnia-platform-docs.vercel.app/markets/somnia-markets/typescript/perps).
- [Pinned npm package](https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1).

## Environment
SDK: 0.32.1; viem: 2.57.7; Node.js: 24.11.1; Windows.
Network: Somnia Hideki testnet, chain 50383 (Tokyo/DreamDEX region).
BTC pool: `0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0`.
Wallet address: not applicable; no wallet or signer used.

## Review status and duplicate risk
Feedback submission candidate, proposed normal severity. No matching title was found in the two public participant indexes inspected on 2026-10-20. This is not proof of novelty: private submissions and other reports were not available.
