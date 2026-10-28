'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { TransactionTracker, ROLES } = require('..')

const A = 'client:1000->server:2000'
const B = 'client:3000->server:2000'

function request (overrides = {}) {
  return { tid: 7, role: ROLES.REQUEST, conversation: A, time: 100, command: 'PING', ...overrides }
}

function response (overrides = {}) {
  return { tid: 7, role: ROLES.RESPONSE, conversation: A, time: 150, ...overrides }
}

test('matches a response with the request command and elapsed time', () => {
  const tracker = new TransactionTracker()
  tracker.track(request())
  const result = tracker.track(response())
  assert.equal(result.status, 'matched')
  assert.equal(result.responseTimeMs, 50)
  assert.equal(result.transaction.command, 'PING')
  assert.equal(result.transaction.tid, 7)
  assert.equal(tracker.stats.pendingEntries, 0)
  assert.equal(tracker.stats.matched, 1)
})

test('retransmissions retain the first request time and count attempts', () => {
  const tracker = new TransactionTracker()
  tracker.track(request())
  tracker.track(request({ time: 120 }))
  const result = tracker.track(request({ time: 140 }))
  assert.equal(result.status, 'retransmission')
  assert.equal(result.transaction.requestTimeMs, 100)
  assert.equal(result.transaction.lastActivityMs, 140)
  assert.equal(result.transaction.attempts, 3)
  assert.equal(tracker.track(response({ time: 175 })).responseTimeMs, 75)
})

test('a transaction id can be reused after the previous match', () => {
  const tracker = new TransactionTracker()
  tracker.track(request())
  tracker.track(response())
  tracker.track(request({ time: 500, command: 'LOOKUP' }))
  const result = tracker.track(response({ time: 525 }))
  assert.equal(result.responseTimeMs, 25)
  assert.equal(result.transaction.command, 'LOOKUP')
})

test('a duplicate response is unmatched after cleanup', () => {
  const tracker = new TransactionTracker()
  tracker.track(request())
  tracker.track(response())
  const result = tracker.track(response({ time: 160 }))
  assert.deepEqual(result, { status: 'unmatched', reason: 'missing_transaction' })
})

test('an unknown response does not create state', () => {
  const tracker = new TransactionTracker()
  const result = tracker.track(response())
  assert.equal(result.status, 'unmatched')
  assert.equal(tracker.stats.pendingEntries, 0)
  assert.equal(tracker.stats.unmatched, 1)
})

test('an out-of-order response leaves the request pending', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ time: 200 }))
  const result = tracker.track(response({ time: 199 }))
  assert.deepEqual(result, { status: 'unmatched', reason: 'out_of_order' })
  assert.equal(tracker.stats.pendingEntries, 1)
  assert.equal(tracker.track(response({ time: 200 })).status, 'matched')
})

test('a relay answer closes a relay forward', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ role: ROLES.RELAY_FORWARD, command: 'PEER_HANDSHAKE' }))
  const result = tracker.track(response({ role: ROLES.RELAY_ANSWER }))
  assert.equal(result.status, 'matched')
  assert.equal(result.transaction.relayed, true)
})

test('a relay answer cannot steal an ordinary request', () => {
  const tracker = new TransactionTracker()
  tracker.track(request())
  const result = tracker.track(response({ role: ROLES.RELAY_ANSWER }))
  assert.deepEqual(result, { status: 'unmatched', reason: 'wrong_role' })
  assert.equal(tracker.stats.pendingEntries, 1)
  assert.equal(tracker.track(response()).status, 'matched')
})

test('an ordinary error response can close a relay forward', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ role: ROLES.RELAY_FORWARD }))
  assert.equal(tracker.track(response()).status, 'matched')
})

test('unanswered legs neither open nor close transactions', () => {
  const tracker = new TransactionTracker()
  assert.equal(tracker.track(request({ role: ROLES.UNANSWERED })).status, 'ignored')
  tracker.track(request())
  assert.equal(tracker.track(request({ role: ROLES.UNANSWERED, time: 120 })).status, 'ignored')
  assert.equal(tracker.stats.pendingEntries, 1)
  assert.equal(tracker.track(response()).status, 'matched')
})

test('PING_NAT aliases match a response on another conversation', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ command: 'PING_NAT', responseConversation: B }))
  assert.equal(tracker.stats.pendingEntries, 2)
  const result = tracker.track(response({ conversation: B, time: 101 }))
  assert.equal(result.status, 'matched')
  assert.equal(result.responseTimeMs, 1)
  assert.equal(result.transaction.responseConversation, B)
  assert.equal(tracker.stats.pendingEntries, 0)
})

test('sweep removes both NAT aliases', () => {
  const tracker = new TransactionTracker({ maxAgeMs: 50 })
  tracker.track(request({ responseConversation: B }))
  const expired = tracker.sweep(151)
  assert.equal(expired.length, 1)
  assert.equal(tracker.stats.pendingEntries, 0)
  assert.equal(tracker.stats.pendingTransactions, 0)
  assert.equal(tracker.stats.timeouts, 1)
})

test('role replacement removes stale NAT aliases', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ responseConversation: B }))
  tracker.track(request({ role: ROLES.RELAY_FORWARD, time: 110 }))
  assert.equal(tracker.stats.pendingEntries, 1)
  assert.equal(tracker.stats.replacements, 1)
  assert.equal(tracker.track(response({ conversation: B, time: 120 })).status, 'unmatched')
  assert.equal(tracker.track(response({ role: ROLES.RELAY_ANSWER, time: 120 })).status, 'matched')
})

test('retransmission refreshes TTL without changing the first timestamp', () => {
  const tracker = new TransactionTracker({ maxAgeMs: 50 })
  tracker.track(request())
  tracker.track(request({ time: 140 }))
  assert.equal(tracker.sweep(150).length, 0)
  assert.equal(tracker.sweep(190).length, 0)
  const expired = tracker.sweep(191)
  assert.equal(expired[0].requestTimeMs, 100)
  assert.equal(expired[0].lastActivityMs, 140)
})

test('entry bounds include NAT aliases and evict the oldest records', () => {
  const tracker = new TransactionTracker({ maxEntries: 3 })
  tracker.track(request({ tid: 1, responseConversation: B }))
  tracker.track(request({ tid: 2, time: 110 }))
  tracker.track(request({ tid: 3, time: 120 }))
  assert.equal(tracker.stats.pendingEntries, 2)
  assert.ok(tracker.stats.pendingTransactions <= 3)
  assert.equal(tracker.stats.evicted, 1)
  assert.equal(tracker.track(response({ tid: 2, time: 130 })).status, 'matched')
})

test('alias capacity errors are atomic', () => {
  const tracker = new TransactionTracker({ maxEntries: 1 })
  tracker.track(request())
  assert.throws(() => tracker.track(request({ tid: 8, responseConversation: B })), /requires 2 entries/)
  assert.equal(tracker.stats.pendingEntries, 1)
  assert.equal(tracker.track(response()).status, 'matched')
})

test('retransmissions preserve the original NAT alias', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ responseConversation: B }))
  const result = tracker.track(request({ time: 110, responseConversation: 'other:1->other:2' }))
  assert.equal(result.transaction.responseConversation, B)
  assert.equal(tracker.stats.pendingEntries, 2)
})

test('snapshots cannot mutate tracker state', () => {
  const tracker = new TransactionTracker()
  const opened = tracker.track(request())
  assert.throws(() => { opened.transaction.command = 'CHANGED' }, TypeError)
  assert.equal(tracker.track(response()).transaction.command, 'PING')
})

test('invalid events are rejected before state changes', () => {
  const tracker = new TransactionTracker()
  const invalid = [
    { tid: -1 }, { tid: 65536 }, { tid: 1.5 },
    { role: 'unknown' }, { conversation: '' }, { conversation: 'bad\0key' },
    { time: -1 }, { time: Number.NaN }, { time: Number.MAX_SAFE_INTEGER + 1 },
    { command: {} }, { command: 'x'.repeat(129) },
    { role: ROLES.RESPONSE, responseConversation: B }
  ]
  for (const patch of invalid) assert.throws(() => tracker.track(request(patch)))
  assert.equal(tracker.stats.pendingEntries, 0)
  assert.throws(() => tracker.sweep(-1), /time/)
})

test('invalid event containers and constructor options are rejected', () => {
  const tracker = new TransactionTracker()
  for (const event of [null, [], 'event', 42]) assert.throws(() => tracker.track(event))
  for (const options of [{ maxAgeMs: 0 }, { maxAgeMs: 1.5 }, { maxEntries: 0 }, { maxEntries: 1.5 }]) {
    assert.throws(() => new TransactionTracker(options))
  }
})

test('null commands are preserved for response interpretation', () => {
  const tracker = new TransactionTracker()
  tracker.track(request({ command: undefined }))
  assert.equal(tracker.track(response()).transaction.command, null)
})

test('deterministic stress keeps maps bounded and matching correct', () => {
  const tracker = new TransactionTracker({ maxEntries: 250, maxAgeMs: 1_000_000 })
  for (let tid = 0; tid < 2000; tid++) {
    const key = `client:${tid % 20}->server:2000`
    tracker.track(request({ tid, conversation: key, time: tid * 2 }))
    const result = tracker.track(response({ tid, conversation: key, time: tid * 2 + 1 }))
    assert.equal(result.status, 'matched')
    assert.equal(result.responseTimeMs, 1)
  }
  for (let tid = 0; tid < 1000; tid++) {
    tracker.track(request({ tid, conversation: `pending:${tid % 50}`, time: 5000 + tid, responseConversation: `alias:${tid % 50}` }))
    assert.ok(tracker.stats.pendingEntries <= 250)
    assert.ok(tracker.stats.pendingTransactions <= 250)
  }
  assert.equal(tracker.stats.opened, 3000)
  assert.equal(tracker.stats.matched, 2000)
  assert.ok(tracker.stats.evicted > 0)
})
