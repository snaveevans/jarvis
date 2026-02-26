import type { LLMClient } from './client.ts'
import type { ChatMessage, ChatCompletionResponse } from './types.ts'
import { getToolDefinitions, executeTool as defaultExecuteTool } from '../tools/index.ts'
import type { ToolCall, ToolResult, ToolExecutionContext } from '../tools/types.ts'

const MAX_TOOL_ITERATIONS = 5
const DEFAULT_MAX_PARALLEL_TOOLS = 5

export type ChatWithToolsClient = Pick<LLMClient, 'chat'>

export interface ToolCallObservation {
  iteration: number
  toolCall: ToolCall
  result: ToolResult
}

export type ToolDefinition = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type ToolExecutor = (call: ToolCall, context?: ToolExecutionContext) => Promise<ToolResult>

export interface ChatWithToolsOptions {
  model?: string
  temperature?: number
  max_tokens?: number
  onToolCall?: (observation: ToolCallObservation) => void
  tools?: ToolDefinition[]
  executeTool?: ToolExecutor
  toolContext?: ToolExecutionContext
  maxParallelTools?: number
}

function createIterationLimitResponse(model?: string): ChatCompletionResponse {
  return {
    id: 'tool_iteration_limit',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: model ?? 'tool-runner',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: `Reached maximum tool iterations (${MAX_TOOL_ITERATIONS}) without producing a final answer. Please narrow the request or split it into smaller steps.`,
        },
        finish_reason: 'stop',
      },
    ],
  }
}

async function withConcurrencyLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0

  async function runNext(): Promise<void> {
    while (nextIndex < tasks.length) {
      const index = nextIndex++
      try {
        const value = await tasks[index]()
        results[index] = { status: 'fulfilled', value }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => runNext()
  )
  await Promise.all(workers)
  return results
}

export async function chatWithTools(
  client: ChatWithToolsClient,
  messages: ChatMessage[],
  options: ChatWithToolsOptions = {}
): Promise<ChatCompletionResponse> {
  const tools = options.tools ?? getToolDefinitions()
  const executeToolFn = options.executeTool ?? defaultExecuteTool
  const maxParallel = options.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS
  let currentMessages = [...messages]
  let iteration = 0
  let latestModel = options.model

  while (iteration < MAX_TOOL_ITERATIONS) {
    iteration++

    const response = await client.chat(currentMessages, {
      model: options.model,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    })
    latestModel = response.model

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

    // Execute tool calls in parallel with concurrency limit
    const toolCalls = choice.message.tool_calls.map(tc => tc as ToolCall)
    const settlements = await withConcurrencyLimit(
      toolCalls.map((toolCall) => async () => {
        const result = await executeToolFn(toolCall, options.toolContext)
        options.onToolCall?.({ iteration, toolCall, result })
        return { toolCall, result }
      }),
      maxParallel
    )

    // Add tool responses in original order
    for (const settlement of settlements) {
      if (settlement.status === 'fulfilled') {
        const { toolCall, result } = settlement.value
        currentMessages.push({
          role: 'tool',
          content: result.error ? `Error: ${result.error}` : result.content,
          tool_call_id: toolCall.id,
        })
      } else {
        // Should not happen (executeTool returns ToolResult, not throws), but handle just in case
        const failedCall = toolCalls[settlements.indexOf(settlement)]
        currentMessages.push({
          role: 'tool',
          content: `Error: Tool execution failed unexpectedly`,
          tool_call_id: failedCall.id,
        })
      }
    }
  }

  // If we hit max iterations, return a clean fallback response.
  return createIterationLimitResponse(latestModel)
}
