import { describe, test } from 'node:test'
import assert from 'node:assert'

import { chatWithTools } from './chat-with-tools.ts'
import type { ChatWithToolsClient, ToolCallObservation } from './chat-with-tools.ts'
import type { ChatCompletionResponse, ChatMessage } from './types.ts'
import type { ToolCall, ToolResult } from '../tools/types.ts'

describe('chatWithTools observability', () => {
  test('emits tool call observations for executed tool calls', async () => {
    let callCount = 0
    const observations: ToolCallObservation[] = []

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        callCount++

        if (callCount === 1) {
          return {
            id: 'resp_tool',
            object: 'chat.completion',
            created: 1,
            model: 'hf:test-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'call_1',
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: '{}',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          }
        }

        return {
          id: 'resp_final',
          object: 'chat.completion',
          created: 2,
          model: 'hf:test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Done',
              },
              finish_reason: 'stop',
            },
          ],
        }
      },
    }

    const messages: ChatMessage[] = [{ role: 'user', content: 'Read a file' }]

    const response = await chatWithTools(mockClient, messages, {
      onToolCall: (observation) => {
        observations.push(observation)
      },
    })

    assert.equal(response.id, 'resp_final')
    assert.equal(observations.length, 1)
    assert.equal(observations[0].iteration, 1)
    assert.equal(observations[0].toolCall.function.name, 'read_file')
    assert.equal(observations[0].toolCall.function.arguments, '{}')
    assert.equal(observations[0].result.error, 'Missing required parameter: path')
  })

  test('does not emit tool call observations when no tool calls are returned', async () => {
    const observations: ToolCallObservation[] = []

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        return {
          id: 'resp_no_tools',
          object: 'chat.completion',
          created: 1,
          model: 'hf:test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'No tools needed',
              },
              finish_reason: 'stop',
            },
          ],
        }
      },
    }

    const messages: ChatMessage[] = [{ role: 'user', content: 'Say hello' }]

    await chatWithTools(mockClient, messages, {
      onToolCall: (observation) => {
        observations.push(observation)
      },
    })

    assert.equal(observations.length, 0)
  })

  test('returns a summary when max tool iterations are reached', async () => {
    let callCount = 0

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        callCount++

        // On the final call (after hitting limit), return a summary
        if (callCount > 5) {
          return {
            id: `resp_final`,
            object: 'chat.completion',
            created: callCount,
            model: 'hf:test-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'I have read 5 files as requested.',
                },
                finish_reason: 'stop',
              },
            ],
          }
        }

        return {
          id: `resp_tool_${callCount}`,
          object: 'chat.completion',
          created: callCount,
          model: 'hf:test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: `call_${callCount}`,
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: '{}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }
      },
    }

    const messages: ChatMessage[] = [{ role: 'user', content: 'Keep using tools' }]
    const response = await chatWithTools(mockClient, messages, { maxIterations: 5 })

    // Should make maxIterations + 1 calls (5 tool iterations + 1 final summary)
    assert.equal(callCount, 6)
    assert.match(
      response.choices[0].message.content,
      /Tool iteration limit reached/
    )
    assert.match(
      response.choices[0].message.content,
      /Tools used:/
    )
    assert.match(
      response.choices[0].message.content,
      /continue/
    )
  })
})

describe('chatWithTools parallel execution', () => {
  test('executes multiple tool calls in parallel', async () => {
    let callCount = 0
    const executionOrder: string[] = []
    let concurrentCount = 0
    let maxConcurrent = 0

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        callCount++

        if (callCount === 1) {
          return {
            id: 'resp_parallel',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'call_a', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
                  { id: 'call_b', type: 'function', function: { name: 'tool_b', arguments: '{}' } },
                  { id: 'call_c', type: 'function', function: { name: 'tool_c', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          }
        }

        return {
          id: 'resp_final',
          object: 'chat.completion',
          created: 2,
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'All done' },
            finish_reason: 'stop',
          }],
        }
      },
    }

    const mockExecuteTool = async (call: ToolCall): Promise<ToolResult> => {
      concurrentCount++
      maxConcurrent = Math.max(maxConcurrent, concurrentCount)
      executionOrder.push(`start:${call.function.name}`)

      // Simulate async work
      await new Promise(resolve => setTimeout(resolve, 10))

      executionOrder.push(`end:${call.function.name}`)
      concurrentCount--
      return { content: `Result from ${call.function.name}` }
    }

    const observations: ToolCallObservation[] = []
    const response = await chatWithTools(mockClient, [{ role: 'user', content: 'Go' }], {
      executeTool: mockExecuteTool,
      onToolCall: (obs) => observations.push(obs),
    })

    assert.equal(response.id, 'resp_final')
    assert.equal(observations.length, 3)

    // All three should have executed concurrently
    assert.ok(maxConcurrent >= 2, `Expected concurrent execution, got max ${maxConcurrent}`)

    // Observations should be in original order of tool calls
    assert.equal(observations[0].toolCall.function.name, 'tool_a')
    assert.equal(observations[1].toolCall.function.name, 'tool_b')
    assert.equal(observations[2].toolCall.function.name, 'tool_c')
  })

  test('results ordered correctly for LLM regardless of completion order', async () => {
    let callCount = 0
    let observedToolMessages: ChatMessage[] = []

    const mockClient: ChatWithToolsClient = {
      async chat(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
        callCount++

        if (callCount === 1) {
          return {
            id: 'resp1',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'slow', type: 'function', function: { name: 'slow_tool', arguments: '{}' } },
                  { id: 'fast', type: 'function', function: { name: 'fast_tool', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          }
        }

        // Capture messages from second call
        observedToolMessages = messages.filter(m => m.role === 'tool')
        return {
          id: 'resp_final',
          object: 'chat.completion',
          created: 2,
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done' },
            finish_reason: 'stop',
          }],
        }
      },
    }

    const mockExecuteTool = async (call: ToolCall): Promise<ToolResult> => {
      // slow_tool takes longer but was called first
      if (call.function.name === 'slow_tool') {
        await new Promise(resolve => setTimeout(resolve, 30))
        return { content: 'slow result' }
      }
      return { content: 'fast result' }
    }

    await chatWithTools(mockClient, [{ role: 'user', content: 'Go' }], {
      executeTool: mockExecuteTool,
    })

    // Tool messages should be in original order (slow first, fast second)
    assert.equal(observedToolMessages.length, 2)
    assert.equal(observedToolMessages[0].tool_call_id, 'slow')
    assert.equal(observedToolMessages[0].content, 'slow result')
    assert.equal(observedToolMessages[1].tool_call_id, 'fast')
    assert.equal(observedToolMessages[1].content, 'fast result')
  })

  test('one tool error does not block others', async () => {
    let callCount = 0

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        callCount++

        if (callCount === 1) {
          return {
            id: 'resp1',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'ok1', type: 'function', function: { name: 'ok_tool', arguments: '{}' } },
                  { id: 'err', type: 'function', function: { name: 'err_tool', arguments: '{}' } },
                  { id: 'ok2', type: 'function', function: { name: 'ok_tool2', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            }],
          }
        }

        return {
          id: 'resp_final',
          object: 'chat.completion',
          created: 2,
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done' },
            finish_reason: 'stop',
          }],
        }
      },
    }

    const observations: ToolCallObservation[] = []
    const mockExecuteTool = async (call: ToolCall): Promise<ToolResult> => {
      if (call.function.name === 'err_tool') {
        return { content: '', error: 'Something went wrong' }
      }
      return { content: `Result from ${call.function.name}` }
    }

    const response = await chatWithTools(mockClient, [{ role: 'user', content: 'Go' }], {
      executeTool: mockExecuteTool,
      onToolCall: (obs) => observations.push(obs),
    })

    assert.equal(response.id, 'resp_final')
    assert.equal(observations.length, 3)

    // Error tool should still have been observed
    assert.ok(observations[1].result.error)
    // Other tools should have succeeded
    assert.ok(!observations[0].result.error)
    assert.ok(!observations[2].result.error)
  })

  test('respects maxParallelTools concurrency limit', async () => {
    let callCount = 0
    let concurrentCount = 0
    let maxConcurrent = 0

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        callCount++

        if (callCount === 1) {
          return {
            id: 'resp1',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: Array.from({ length: 6 }, (_, i) => ({
                  id: `call_${i}`,
                  type: 'function' as const,
                  function: { name: `tool_${i}`, arguments: '{}' },
                })),
              },
              finish_reason: 'tool_calls',
            }],
          }
        }

        return {
          id: 'resp_final',
          object: 'chat.completion',
          created: 2,
          model: 'test-model',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Done' },
            finish_reason: 'stop',
          }],
        }
      },
    }

    const mockExecuteTool = async (call: ToolCall): Promise<ToolResult> => {
      concurrentCount++
      maxConcurrent = Math.max(maxConcurrent, concurrentCount)
      await new Promise(resolve => setTimeout(resolve, 20))
      concurrentCount--
      return { content: `ok` }
    }

    await chatWithTools(mockClient, [{ role: 'user', content: 'Go' }], {
      executeTool: mockExecuteTool,
      maxParallelTools: 2,
    })

    // Should never exceed the limit of 2
    assert.ok(maxConcurrent <= 2, `Expected max 2 concurrent, got ${maxConcurrent}`)
    assert.ok(maxConcurrent >= 2, `Expected at least 2 concurrent, got ${maxConcurrent}`)
  })
})
