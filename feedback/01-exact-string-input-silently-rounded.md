# Exact decimal string conversion silently rounds despite the published preservation-or-rejection contract
Severity: normal
Area: SDK

## Steps to reproduce
1. Install the pinned dependencies with the command in the README.
2. Run `npm run verify`, or evaluate `fromHuman("0.0000009", 6)` and `fromHuman("0.0000000000000000009", 18)` from `@somnia-chain/markets-sdk`.
3. Compare the returned atoms with the exact input strings and the `fromHuman` documentation shipped in `dist/units.d.ts` (lines 23–35 in 0.32.1).

## Expected
The published description distinguishes numeric input rounding from string input intended for exact preservation or rejection. An unrepresentable exact string should therefore be rejected, or the API should clearly document that strings also round and expose an explicit strict alternative.

## Actual
Both example strings return `1n` without an error. They represent 0.9 of an atom but are converted to a whole atom, increasing the supplied value. An 8-decimal example, `"0.123456789"`, becomes `12345679n`, while exactly representable `"0.12345678"` returns `12345678n` as a control.

This follows the direct `parseUnits` call in `src/units.ts`, not a floating-point conversion by this reproducer. The mismatch is between the SDK's published string contract and its runtime behavior. We have not demonstrated an on-chain loss or claimed a precision-preserving integer result could exist for a fractional atom.

## Evidence
- `evidence/candidate-verification.json`: three string cases and an exactly representable control.
- `scripts/verify-candidates.mjs`: deterministic assertions; no credentials or I/O needed for this part.
- Installed SDK: `dist/units.d.ts` and `src/units.ts`, `fromHuman`.
- [Pinned official npm package](https://www.npmjs.com/package/@somnia-chain/markets-sdk/v/0.32.1).

## Environment
SDK: 0.32.1; viem: 2.57.7; Node.js: 24.11.1; Windows.
Network: pure-function reproduction; no network is needed for the string checks. Other checks in the same script target Somnia Hideki testnet, chain 50383 (Tokyo/DreamDEX region).
Wallet address: not applicable; no wallet or signer used.

## Review status and duplicate risk
Feedback submission candidate, proposed normal severity. A public participant already reports `fromHuman` behavior for large numeric inputs and raw error classes. This string-rounding discrepancy has a different trigger and expected behavior, but the organizer may group them under the same helper. Novelty and acceptance are unverified.
