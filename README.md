# dreamDEX Perps Feedback

Three independently reproduced **normal** Feedback candidates for the dreamDEX Perps Builder Bounty. Acceptance, novelty and payment are determined by the organizer. They cover documentation/SDK consistency, not a demonstrated trading loss or contract exploit.

## Reproduce

Requirements: Node.js 24.11.1 and npm 11.18.0 were tested. The lockfile pins the installed dependency graph; the direct dependencies are markets-sdk 0.32.1 and viem 2.57.7. Both were obtained from the official npm registry. SDK license: MIT; its package retains the license notice.

```powershell
npm ci --ignore-scripts --no-audit --no-fund --cache ./.npm-cache
npm run verify
npm run survey
```

Run from this directory. Neither script reads a private key, requests a signature, claims funds or submits a transaction. `verify` uses public RPC/indexer reads and WebSocket watch acquisition/hydration; it closes the watch and exchange. Both scripts have deadlines and save timestamped JSON in `evidence/`. The findings verification checks observations that establish the discrepancies; passing means the discrepancies were reproduced, not that the SDK was fixed.

## Reports

- [01 — Exact decimal strings are silently rounded](feedback/01-exact-string-input-silently-rounded.md)
- [02 — fundingRate property documentation uses the wrong time basis](feedback/02-funding-rate-property-time-basis.md)
- [03 — Realtime guide contradicts the shipped perp watch capability](feedback/03-perp-watch-guide-contradiction.md)

Proposed severities are normal and remain subject to organizer review. Wallet address is not applicable: all checks run without an account or signer on Hideki testnet (50383), the event's Tokyo/DreamDEX region.

## Scope and limits

The public REST service was reachable but its documented staging environment returned three Shannon spot markets, whereas the target SDK indexer returned 21 Hideki perps. This is recorded in the private workspace investigation notes as a documentation/access question, not asserted as a REST bug.

An unauthenticated browser reproduction of the Perps-to-spot redirect matched a pre-existing public report and was excluded. Known voucher, symbol-casing and missing-error reports were also excluded. Two public participant report indexes were reviewed for duplicate screening; the organizer's private Builds and unpublished reports remain inaccessible. Exact-string behavior touches the same helper as a pre-existing report about large numeric input and error classes, so duplicate treatment of that candidate is especially uncertain.

## Method transparency

AI assistance was used to investigate public documentation, prepare the scripts and write the reports. The included reproduction programs were executed against the pinned SDK and public testnet endpoints; their timestamped outputs are included. No claim is made that the organizer has approved AI assistance or accepted these items. No private key, signature, fund claim or transaction was used.

The organizer decides eligibility, duplicate precedence, severity and rewards. This repository contains no security vulnerability report.
