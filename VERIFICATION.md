# Verification

## Environment

- Node.js 20.19.4, 22.23.2, and 24.19.0
- CommonJS, zero runtime dependencies, `node:test`
- No sockets, timers, network calls, or external services

## Commands

```bash
npm install --package-lock-only --ignore-scripts
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
```

The same lint, test, and package dry-run sequence passed on Node 20.19.4, 22.23.2, and 24.19.0. All 22 tests pass on each version. Node 24 reports 100% line, branch, and function coverage for `index.js` and `lib/transaction-tracker.js`.

`npm pack --dry-run` contains six files: `LICENSE`, `README.md`, `examples/basic.js`, `index.js`, `lib/transaction-tracker.js`, and `package.json`. Package size is approximately 5.0 kB compressed and 13.5 kB unpacked. The package lock audit reports zero vulnerabilities.

## Behavioral coverage

The 22 tests cover:

- Request/response correlation, command inheritance, and response time
- Retransmission timestamps and attempt counts
- Transaction-id reuse and duplicate/unknown/out-of-order responses
- Relay forwards, relay answers, wrong-role rejection, and ordinary error responses
- Unanswered relay legs
- PING_NAT aliases, cross-conversation matching, cleanup, and stale-alias replacement
- TTL refresh and expiration
- Entry bounds, alias-aware eviction, and atomic capacity errors
- Input validation and immutable snapshots
- Null commands
- A deterministic stress scenario with 3,000 opened transactions, 2,000 matches, and bounded pending entries

## Critique against the protocol reference

The implementation preserves first-request timing across retransmissions, distinguishes relay answers from ordinary requests, permits an ordinary response to close a relay forward, and returns the request's command because dht-rpc replies do not carry one. Completed transactions are removed, unlike the Wireshark capture's retained frame links; callers must retain match results. Pending same-role requests are treated as retransmissions because payload-based identity is outside this module's scope.

Input sizes and map entries are bounded. NAT aliases count toward the same entry limit. Replacement and expiry remove every alias without deleting a newer transaction occupying the same key.

## Publication status

The GitHub Actions matrix is prepared but has not run remotely. No GitHub repository or npm package has been published. Local verification does not establish production adoption, upstream acceptance, or an employment outcome.
