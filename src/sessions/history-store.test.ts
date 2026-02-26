import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { test, describe } from 'node:test'

import { createSessionHistoryStore } from './history-store.ts'

describe('SessionHistoryStore', () => {
  test('appends and loads recent messages by sequence', async () => {
    const tempDir = await mkdtemp(path.join(process.cwd(), '.tmp-history-'))
    const dbPath = path.join(tempDir, 'session-history.db')
    const store = createSessionHistoryStore({ dbPath })
    try {
      store.appendMessage('s1', 'cli', 1, 'user', 'hello')
      store.appendMessage('s1', 'cli', 2, 'assistant', 'hi')
      store.appendMessage('s1', 'cli', 3, 'user', 'how are you')

      const recent = store.loadRecentMessages('s1', 2)
      assert.equal(recent.length, 2)
      assert.equal(recent[0].seq, 2)
      assert.equal(recent[0].role, 'assistant')
      assert.equal(recent[1].seq, 3)
      assert.equal(recent[1].content, 'how are you')
    } finally {
      store.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('purges only processed eviction batches', async () => {
    const tempDir = await mkdtemp(path.join(process.cwd(), '.tmp-history-'))
    const dbPath = path.join(tempDir, 'session-history.db')
    const store = createSessionHistoryStore({ dbPath })
    try {
      store.appendMessage('s1', 'cli', 1, 'user', 'u1')
      store.appendMessage('s1', 'cli', 2, 'assistant', 'a1')
      store.appendMessage('s1', 'cli', 3, 'user', 'u2')

      const batchId = store.createEvictionBatch('s1', 1, 2)

      // Pending batches should not purge.
      const firstPurge = store.purgeProcessedMessagesOlderThan(0)
      assert.equal(firstPurge, 0)

      store.markBatchStatus(batchId, 'processed')
      const secondPurge = store.purgeProcessedMessagesOlderThan(0)
      assert.equal(secondPurge, 2)

      const remaining = store.loadRecentMessages('s1', 10)
      assert.equal(remaining.length, 1)
      assert.equal(remaining[0].seq, 3)
    } finally {
      store.close()
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
