# dht-rpc-transaction-tracker

A zero-dependency Node.js state machine for correlating decoded DHT-RPC requests, responses, retransmissions, transaction-id reuse, PING_NAT reply aliases, and relayed handshake/holepunch legs.

The semantics are based on dht-rpc's 16-bit transaction ids and the transaction behavior implemented for the merged Wireshark DHT-RPC/HyperDHT dissector. This package works on **decoded events**; it does not parse UDP packets, implement DHT-RPC, or replace the reference `dht-rpc` package.

## Requirements

- Node.js 20 or newer
- No runtime dependencies, timers, sockets, or background work

## Install

```bash
npm install dht-rpc-transaction-tracker
```

The package is currently prepared for publication; that command will work only after an npm release. For local development, clone the repository and run `npm ci`.

## Example

```js
const { TransactionTracker, ROLES } = require('dht-rpc-transaction-tracker')

const tracker = new TransactionTracker({ maxAgeMs: 60_000, maxEntries: 10_000 })
const conversation = 'client:49761->server:49737'

tracker.track({
  tid: 42,
  role: ROLES.REQUEST,
  conversation,
  time: 100,
  command: 'PING'
})

const result = tracker.track({
  tid: 42,
  role: ROLES.RESPONSE,
  conversation,
  time: 125
})

console.log(result.status)         // matched
console.log(result.responseTimeMs) // 25
console.log(result.transaction.command) // PING
```

Responses do not carry a command on the wire, so a match returns the command stored from the request.

## API

### `new TransactionTracker(options?)`

Options:

- `maxAgeMs` (default `60000`): maximum pending age after the most recent retransmission.
- `maxEntries` (default `10000`): maximum pending map entries. A PING_NAT transaction with a reply alias counts as two entries.

### `tracker.track(event)`

Every event requires:

- `tid`: integer from `0` through `65535`.
- `role`: one of `ROLES.REQUEST`, `RESPONSE`, `RELAY_FORWARD`, `RELAY_ANSWER`, or `UNANSWERED`.
- `conversation`: non-empty string identifying the five-tuple or equivalent flow. The caller must normalize it consistently.
- `time`: finite, non-negative safe-number milliseconds in a single clock domain. Inject capture timestamps for deterministic analysis.

Request roles also accept:

- `command`: string of at most 128 characters, finite number, `null`, or omitted.
- `responseConversation`: optional alias for a PING_NAT reply arriving on another conversation.

Return values:

- `open`: a new transaction was registered.
- `retransmission`: the same role reused a pending transaction id. The first request timestamp is preserved; attempts and last activity advance.
- `matched`: a response or relay answer completed a transaction. Includes `responseTimeMs` and an immutable transaction snapshot.
- `unmatched`: a response could not be paired. Includes `reason`: `missing_transaction`, `wrong_role`, or `out_of_order`.
- `ignored`: an unanswered relay leg was ignored without changing state.

A pending request with the same role is treated as a retransmission. A request with a different role replaces the old transaction and removes all of its aliases. An ordinary response can close a relay forward, which allows an error response from a node that does not understand the command. A relay answer can close only a relay forward.

### `tracker.sweep(time)`

Expires pending transactions whose age since their last activity is greater than `maxAgeMs`. Returns immutable snapshots of expired records and cleans every alias. No timer runs automatically; call this from your application's existing scheduler.

### `tracker.stats`

Returns a frozen statistics object containing `opened`, `matched`, `retransmissions`, `replacements`, `unmatched`, `ignored`, `timeouts`, `evicted`, `pendingEntries`, and `pendingTransactions`.

## Limits

- Correlation is only as accurate as the caller's decoded roles, normalized conversations, and timestamps.
- A response before the request timestamp is rejected as `out_of_order`; use one clock domain.
- Completed transactions are removed. Their result must be retained by the caller if later inspection is needed.
- The tracker deliberately does not infer retransmissions from payloads or decrypt any traffic.

## Development

```bash
npm ci
npm run lint
npm test
npm run test:coverage
npm pack --dry-run
```

The CI matrix covers Node.js 20, 22, and 24. The test suite uses `node:test` and deterministic timestamps; no network or external service is required.

## License

MIT
