import { afterEach, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createMemoryService } from './service.ts'

describe('MemoryService', () => {
  let memoryDir: string

  beforeEach(async () => {
    memoryDir = await mkdtemp(path.join(tmpdir(), 'jarvis-memory-test-'))
  })

  afterEach(async () => {
    await rm(memoryDir, { recursive: true, force: true })
  })

  test('stores and searches memories', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      const storeResult = await service.store({
        content: 'I prefer functional patterns over classes.',
        type: 'preference',
        tags: ['typescript'],
      })

      assert.equal(storeResult.deduplicated, false)
      assert.equal(storeResult.memory.type, 'preference')

      const searchResults = await service.search({
        query: 'functional',
        type: 'preference',
      })

      assert.equal(searchResults.length, 1)
      assert.equal(searchResults[0].id, storeResult.memory.id)
    } finally {
      service.close()
    }
  })

  test('deduplicates near-exact content', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      const first = await service.store({
        content: 'Auth uses JWT access tokens.',
        type: 'fact',
      })
      const second = await service.store({
        content: '  auth uses   jwt access tokens. ',
        type: 'fact',
      })

      assert.equal(first.memory.id, second.memory.id)
      assert.equal(second.deduplicated, true)
    } finally {
      service.close()
    }
  })

  test('builds bounded auto-context block', async () => {
    const service = createMemoryService({ memoryDir })
    try {
      await service.store({
        content: 'Project uses TypeScript strict mode.',
        type: 'fact',
      })
      await service.store({
        content: 'Use concise commit messages.',
        type: 'preference',
      })

      const context = await service.getAutoContext('TypeScript project')
      assert.ok(context)
      assert.match(context!, /Relevant context from memory:/)
      assert.match(context!, /TypeScript strict mode/)
    } finally {
      service.close()
    }
  })

  test('summarizes non-trivial conversations into conversation_summary', async () => {
    const service = createMemoryService({ memoryDir })
    const mockClient = {
      async chat() {
        return {
          id: 'sum-1',
          object: 'chat.completion',
          created: Date.now(),
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant' as const, content: 'Decided to keep auth logic modular.' },
            finish_reason: 'stop',
          }],
        }
      },
    }

    try {
      await service.summarizeAndStore({
        client: mockClient,
        model: 'test-model',
        messages: [
          { role: 'user', content: 'x'.repeat(900) },
          { role: 'assistant', content: 'Got it.' },
        ],
      })

      const summaries = await service.getRecent(10, 'conversation_summary')
      assert.equal(summaries.length, 1)
      assert.match(summaries[0].content, /auth logic modular/)
    } finally {
      service.close()
    }
  })
})
