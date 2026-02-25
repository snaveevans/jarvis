import { test, describe } from 'node:test'
import assert from 'node:assert'
import type {
  ChatMessage,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Tool,
  ToolCall,
  Model,
} from './types.ts'

describe('Type definitions', () => {
  test('ChatMessage interface structure', () => {
    const message: ChatMessage = {
      role: 'user',
      content: 'Hello',
    }
    assert.equal(message.role, 'user')
    assert.equal(message.content, 'Hello')
  })

  test('ChatMessage with all optional fields', () => {
    const toolCall: ToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'test_function',
        arguments: '{"key": "value"}',
      },
    }

    const message: ChatMessage = {
      role: 'assistant',
      content: 'Using tool',
      name: 'assistant_name',
      tool_calls: [toolCall],
      tool_call_id: 'call_123',
    }

    assert.equal(message.role, 'assistant')
    assert.ok(message.tool_calls)
    assert.equal(message.tool_calls[0].id, 'call_123')
  })

  test('ChatCompletionRequest interface', () => {
    const request: ChatCompletionRequest = {
      model: 'hf:test-model',
      messages: [{ role: 'user', content: 'Hello' }],
      temperature: 0.7,
      max_tokens: 100,
      stream: false,
    }

    assert.equal(request.model, 'hf:test-model')
    assert.equal(request.messages.length, 1)
    assert.equal(request.temperature, 0.7)
  })

  test('Tool interface structure', () => {
    const tool: Tool = {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        parameters: {
          type: 'object',
          properties: {},
        },
      },
    }

    assert.equal(tool.type, 'function')
    assert.equal(tool.function.name, 'get_weather')
  })

  test('Model interface structure', () => {
    const model: Model = {
      id: 'hf:test-model',
      object: 'model',
      created: 1234567890,
      owned_by: 'test-owner',
    }

    assert.equal(model.id, 'hf:test-model')
    assert.equal(model.owned_by, 'test-owner')
  })

  test('ChatCompletionResponse structure', () => {
    const response: ChatCompletionResponse = {
      id: 'resp_123',
      object: 'chat.completion',
      created: 1234567890,
      model: 'hf:test-model',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Hello!',
          },
          finish_reason: 'stop',
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    }

    assert.equal(response.choices.length, 1)
    assert.equal(response.choices[0].message.content, 'Hello!')
    assert.equal(response.usage?.total_tokens, 15)
  })

  test('ChatCompletionChunk structure', () => {
    const chunk: ChatCompletionChunk = {
      id: 'chunk_123',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'hf:test-model',
      choices: [
        {
          index: 0,
          delta: { content: 'Hello' },
          finish_reason: null,
        },
      ],
    }

    assert.equal(chunk.choices[0].delta.content, 'Hello')
    assert.equal(chunk.choices[0].finish_reason, null)
  })
})
