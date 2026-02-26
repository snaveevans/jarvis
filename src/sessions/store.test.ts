import { test, describe } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'

import { createInMemorySessionStore } from './store.ts'
import { createSessionHistoryStore } from './history-store.ts'

describe('createInMemorySessionStore', () => {
  test('get returns undefined for unknown session', () => {
    const store = createInMemorySessionStore()
    assert.equal(store.get('unknown'), undefined)
  })

  test('getOrCreate creates a new session', () => {
    const store = createInMemorySessionStore()
    const session = store.getOrCreate('telegram:123', 'telegram')

    assert.equal(session.id, 'telegram:123')
    assert.equal(session.endpointKind, 'telegram')
    assert.deepEqual(session.messages, [])
    assert.ok(session.createdAt instanceof Date)
  })

  test('getOrCreate returns existing session on second call', () => {
    const store = createInMemorySessionStore()
    const first = store.getOrCreate('cli:default', 'cli')
    first.messages.push({ role: 'user', content: 'hello' })

    const second = store.getOrCreate('cli:default', 'cli')
    assert.strictEqual(first, second)
    assert.equal(second.messages.length, 1)
  })

  test('get returns session after creation', () => {
    const store = createInMemorySessionStore()
    store.getOrCreate('s1', 'cli')

    const session = store.get('s1')
    assert.ok(session)
    assert.equal(session.id, 's1')
  })

  test('clear removes session', () => {
    const store = createInMemorySessionStore()
    store.getOrCreate('s1', 'cli')

    store.clear('s1')
    assert.equal(store.get('s1'), undefined)
  })

  test('clear is safe on unknown session', () => {
    const store = createInMemorySessionStore()
    store.clear('nonexistent')
  })

  test('addMessage appends to existing session', () => {
    const store = createInMemorySessionStore()
    store.getOrCreate('s1', 'telegram')

    store.addMessage('s1', { role: 'user', content: 'hello' })
    store.addMessage('s1', { role: 'assistant', content: 'hi' })

    const session = store.get('s1')!
    assert.equal(session.messages.length, 2)
    assert.equal(session.messages[0].content, 'hello')
    assert.equal(session.messages[1].content, 'hi')
  })

  test('addMessage is safe on unknown session', () => {
    const store = createInMemorySessionStore()
    store.addMessage('nonexistent', { role: 'user', content: 'hello' })
  })

  test('rehydrates user/assistant history for an existing session id', async () => {
    const tempDir = await mkdtemp(path.join(process.cwd(), '.tmp-session-store-'))
    const historyStore = createSessionHistoryStore({ dbPath: path.join(tempDir, 'session-history.db') })
    try {
      historyStore.appendMessage('s1', 'cli', 1, 'user', 'hello')
      historyStore.appendMessage('s1', 'cli', 2, 'assistant', 'hi')

      const store = createInMemorySessionStore({
        historyStore,
        historyReplayMaxMessages: 20,
      })
      const session = store.getOrCreate('s1', 'cli')
      assert.equal(session.messages.length, 2)
      assert.equal(session.messages[0].role, 'user')
      assert.equal(session.messages[1].role, 'assistant')
      assert.equal(session.messages[1].content, 'hi')
    } finally {
      historyStore.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('rehydrates assistant history without think tags', async () => {
    const tempDir = await mkdtemp(path.join(process.cwd(), '.tmp-session-store-'))
    const historyStore = createSessionHistoryStore({ dbPath: path.join(tempDir, 'session-history.db') })
    try {
      historyStore.appendMessage('s1', 'cli', 1, 'user', 'hello')
      historyStore.appendMessage('s1', 'cli', 2, 'assistant', '<think>internal</think>visible')

      const store = createInMemorySessionStore({
        historyStore,
        historyReplayMaxMessages: 20,
      })
      const session = store.getOrCreate('s1', 'cli')
      assert.equal(session.messages.length, 2)
      assert.equal(session.messages[1].content, 'visible')
    } finally {
      historyStore.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
