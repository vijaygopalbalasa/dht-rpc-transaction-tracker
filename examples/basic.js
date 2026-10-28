'use strict'

const { TransactionTracker, ROLES } = require('..')

const tracker = new TransactionTracker({ maxAgeMs: 5_000, maxEntries: 1_000 })
const conversation = '192.0.2.10:49761->192.0.2.20:49737'

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

console.log(result)
