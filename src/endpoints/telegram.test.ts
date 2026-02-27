import { describe, test } from 'node:test'
import assert from 'node:assert'

import { resolveTelegramChatIdFromSessionId, splitMessage } from './telegram.ts'

describe('telegram endpoint helpers', () => {
  test('resolveTelegramChatIdFromSessionId parses valid ids', () => {
    assert.equal(resolveTelegramChatIdFromSessionId('telegram:123456'), 123456)
    assert.equal(resolveTelegramChatIdFromSessionId('telegram:-1009876543210'), -1009876543210)
  })

  test('resolveTelegramChatIdFromSessionId rejects invalid formats', () => {
    assert.equal(resolveTelegramChatIdFromSessionId('cli:default'), undefined)
    assert.equal(resolveTelegramChatIdFromSessionId('telegram:not-a-number'), undefined)
    assert.equal(resolveTelegramChatIdFromSessionId('telegram:'), undefined)
  })

  test('splitMessage respects max length', () => {
    const chunks = splitMessage('hello world from jarvis', 10)
    assert.ok(chunks.every(chunk => chunk.length <= 10))
    assert.equal(chunks.join(''), 'hello world from jarvis')
  })
})
