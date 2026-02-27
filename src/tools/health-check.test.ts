import assert from 'node:assert'
import { describe, test } from 'node:test'

import type { LLMClient } from '../llm/client.ts'
import { createHealthCheckTool } from './health-check.ts'

describe('health_check tool', () => {
  test('falls back to completion probe when /models fails', async () => {
    const client = {
      listModels: async () => {
        throw new Error('models endpoint not supported')
      },
      chat: async () => ({
        id: 'test',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'OK' },
            finish_reason: 'stop',
          },
        ],
      }),
    } as unknown as LLMClient

    const tool = createHealthCheckTool({ client })
    const result = await tool.execute({})

    assert.equal(result.error, undefined)
    assert.match(result.content, /LLM API: ok/)
    assert.match(result.content, /completion probe succeeded after \/models failed/)
  })

  test('returns error when both /models and completion probe fail', async () => {
    const client = {
      listModels: async () => {
        throw new Error('models endpoint not supported')
      },
      chat: async () => {
        throw new Error('chat completion failed')
      },
    } as unknown as LLMClient

    const tool = createHealthCheckTool({ client })
    const result = await tool.execute({})

    assert.equal(result.error, undefined)
    assert.match(result.content, /LLM API: error/)
    assert.match(result.content, /\/models failed/)
    assert.match(result.content, /completion probe failed/)
  })
})
