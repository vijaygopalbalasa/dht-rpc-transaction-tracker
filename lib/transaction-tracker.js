'use strict'

const ROLES = Object.freeze({
  REQUEST: 'request',
  RESPONSE: 'response',
  RELAY_FORWARD: 'relayForward',
  RELAY_ANSWER: 'relayAnswer',
  UNANSWERED: 'unanswered'
})

const OPEN_ROLES = new Set([ROLES.REQUEST, ROLES.RELAY_FORWARD])
const CLOSE_ROLES = new Set([ROLES.RESPONSE, ROLES.RELAY_ANSWER])

function validateTime (time) {
  if (!Number.isFinite(time) || time < 0 || time > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('time must be a finite, non-negative safe number')
  }
}

function validateConversation (conversation, name = 'conversation') {
  if (typeof conversation !== 'string' || conversation.length === 0 || conversation.length > 512 || conversation.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty string of at most 512 characters without NUL`)
  }
}

function validateEvent (event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new TypeError('event must be an object')
  }
  if (!Number.isInteger(event.tid) || event.tid < 0 || event.tid > 65535) {
    throw new RangeError('tid must be an integer from 0 through 65535')
  }
  if (!OPEN_ROLES.has(event.role) && !CLOSE_ROLES.has(event.role) && event.role !== ROLES.UNANSWERED) {
    throw new RangeError(`unknown role: ${event.role}`)
  }
  validateConversation(event.conversation)
  validateTime(event.time)
  if (typeof event.command === 'string' && event.command.length > 128) {
    throw new TypeError('command string must contain at most 128 characters')
  }
  if (event.command !== undefined && event.command !== null && typeof event.command !== 'string' && !Number.isFinite(event.command)) {
    throw new TypeError('command must be a string, finite number, null, or undefined')
  }
  if (event.responseConversation !== undefined && event.responseConversation !== null) {
    if (!OPEN_ROLES.has(event.role)) {
      throw new RangeError('responseConversation is valid only for request roles')
    }
    validateConversation(event.responseConversation, 'responseConversation')
  }
}

function snapshot (record) {
  return Object.freeze({
    tid: record.tid,
    command: record.command,
    conversation: record.conversation,
    responseConversation: record.responseConversation,
    requestTimeMs: record.requestTimeMs,
    lastActivityMs: record.lastActivityMs,
    relayed: record.relayed,
    attempts: record.attempts
  })
}

class TransactionTracker {
  constructor ({ maxAgeMs = 60_000, maxEntries = 10_000 } = {}) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) {
      throw new RangeError('maxAgeMs must be a positive safe integer')
    }
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('maxEntries must be a positive safe integer')
    }

    this.maxAgeMs = maxAgeMs
    this.maxEntries = maxEntries
    this._transactions = new Map()
    this._records = new Set()
    this._stats = {
      opened: 0,
      matched: 0,
      retransmissions: 0,
      replacements: 0,
      unmatched: 0,
      ignored: 0,
      timeouts: 0,
      evicted: 0
    }
  }

  get stats () {
    return Object.freeze({
      ...this._stats,
      pendingEntries: this._transactions.size,
      pendingTransactions: this._records.size
    })
  }

  track (event) {
    validateEvent(event)

    if (event.role === ROLES.UNANSWERED) {
      this._stats.ignored++
      return Object.freeze({ status: 'ignored' })
    }

    return OPEN_ROLES.has(event.role) ? this._open(event) : this._close(event)
  }

  sweep (time) {
    validateTime(time)
    const expired = []

    for (const record of this._records) {
      const age = time - record.lastActivityMs
      if (age <= this.maxAgeMs) continue
      expired.push(snapshot(record))
      this._delete(record)
      this._stats.timeouts++
    }

    return expired
  }

  _open (event) {
    const key = this._key(event.conversation, event.tid)
    const relayed = event.role === ROLES.RELAY_FORWARD
    const existing = this._transactions.get(key)

    if (existing && existing.relayed === relayed) {
      existing.attempts++
      existing.lastActivityMs = Math.max(existing.lastActivityMs, event.time)
      this._stats.retransmissions++
      return Object.freeze({ status: 'retransmission', transaction: snapshot(existing) })
    }

    const hasAlias = event.responseConversation != null && event.responseConversation !== event.conversation
    const requiredEntries = hasAlias ? 2 : 1
    if (requiredEntries > this.maxEntries) {
      throw new RangeError(`transaction requires ${requiredEntries} entries but maxEntries is ${this.maxEntries}`)
    }

    if (existing) {
      this._delete(existing)
      this._stats.replacements++
    }
    this._evictToFit(requiredEntries)

    const record = {
      tid: event.tid,
      command: event.command ?? null,
      conversation: event.conversation,
      responseConversation: hasAlias ? event.responseConversation : null,
      requestTimeMs: event.time,
      lastActivityMs: event.time,
      relayed,
      attempts: 1,
      keys: [key]
    }
    if (hasAlias) record.keys.push(this._key(event.responseConversation, event.tid))

    this._records.add(record)
    for (const recordKey of record.keys) this._transactions.set(recordKey, record)
    this._stats.opened++

    return Object.freeze({ status: 'open', transaction: snapshot(record) })
  }

  _close (event) {
    const key = this._key(event.conversation, event.tid)
    const record = this._transactions.get(key)

    if (!record) return this._unmatched('missing_transaction')
    if (event.role === ROLES.RELAY_ANSWER && !record.relayed) return this._unmatched('wrong_role')
    if (event.time < record.requestTimeMs) return this._unmatched('out_of_order')

    this._delete(record)
    this._stats.matched++

    return Object.freeze({
      status: 'matched',
      responseTimeMs: event.time - record.requestTimeMs,
      transaction: snapshot(record)
    })
  }

  _unmatched (reason) {
    this._stats.unmatched++
    return Object.freeze({ status: 'unmatched', reason })
  }

  _evictToFit (requiredEntries) {
    while (this._transactions.size + requiredEntries > this.maxEntries) {
      const oldest = this._records.values().next().value
      this._delete(oldest)
      this._stats.evicted++
    }
  }

  _delete (record) {
    for (const key of record.keys) {
      if (this._transactions.get(key) === record) this._transactions.delete(key)
    }
    this._records.delete(record)
  }

  _key (conversation, tid) {
    return `${conversation}\0${tid}`
  }
}

module.exports = { TransactionTracker, ROLES }
