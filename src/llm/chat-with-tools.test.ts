import { describe, test } from 'node:test'
import assert from 'node:assert'

import { chatWithTools } from './chat-with-tools.ts'
import type { ChatWithToolsClient, ToolCallObservation } from './chat-with-tools.ts'
import type { ChatCompletionResponse, ChatMessage } from './types.ts'

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

  test('returns a clean fallback when max tool iterations are reached', async () => {
    let callCount = 0

    const mockClient: ChatWithToolsClient = {
      async chat(): Promise<ChatCompletionResponse> {
        callCount++

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
    const response = await chatWithTools(mockClient, messages)

    assert.equal(response.id, 'tool_iteration_limit')
    assert.equal(callCount, 5)
    assert.match(
      response.choices[0].message.content,
      /Reached maximum tool iterations \(5\)/
    )
  })
})
