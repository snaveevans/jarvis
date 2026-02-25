import { LLMClient } from './client.ts'
import type { ChatMessage, ChatCompletionResponse } from './types.ts'
import { getToolDefinitions, executeTool } from '../tools/index.ts'
import type { ToolCall } from '../tools/types.ts'

const MAX_TOOL_ITERATIONS = 5

export interface ChatWithToolsOptions {
  model?: string
  temperature?: number
  max_tokens?: number
}

export async function chatWithTools(
  client: LLMClient,
  messages: ChatMessage[],
  options: ChatWithToolsOptions = {}
): Promise<ChatCompletionResponse> {
  const tools = getToolDefinitions()
  let currentMessages = [...messages]
  let iteration = 0

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++

    const response = await client.chat(currentMessages, {
      model: options.model,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    })

    const choice = response.choices[0]
    if (!choice) {
      throw new Error('No response from LLM')
    }

    // If no tool calls, we're done
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      return response
    }

    // Add assistant's message with tool calls
    currentMessages.push({
      role: 'assistant',
      content: choice.message.content ?? '',
      tool_calls: choice.message.tool_calls,
    })

    // Execute each tool call
    for (const toolCall of choice.message.tool_calls) {
      const result = await executeTool(toolCall as ToolCall)

      // Add tool response
      currentMessages.push({
        role: 'tool',
        content: result.error ? `Error: ${result.error}` : result.content,
        tool_call_id: toolCall.id,
      })
    }
  }

  // If we hit max iterations, return last response
  return await client.chat(currentMessages, {
    model: options.model,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
  })
}
