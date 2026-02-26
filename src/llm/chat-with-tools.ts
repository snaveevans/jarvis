import type { LLMClient } from './client.ts'
import type { ChatMessage, ChatCompletionResponse } from './types.ts'
import { getToolDefinitions, executeTool as defaultExecuteTool } from '../tools/index.ts'
import { parsePositiveEnvInt } from '../tools/common.ts'
import { estimateTokenCount } from '../memory/helpers.ts'
import type { ToolCall, ToolResult, ToolExecutionContext } from '../tools/types.ts'

const MAX_TOOL_ITERATIONS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_ITERATIONS', 5)
const DEFAULT_MAX_PARALLEL_TOOLS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_PARALLEL', 5)
const DEFAULT_MAX_TOOL_OUTPUT_TOKENS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_OUTPUT_TOKENS', 4000)
const DEFAULT_MAX_CONTEXT_TOKENS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_CONTEXT_TOKENS', 24000)

export type ChatWithToolsClient =
  Pick<LLMClient, 'chat'> & Partial<Pick<LLMClient, 'toUserVisibleContent'>>

export interface ToolCallObservation {
  iteration: number
  toolCall: ToolCall
  result: ToolResult
  durationMs: number
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
  maxIterations?: number
  maxToolOutputTokens?: number
  maxContextTokens?: number
}

function createIterationLimitResponse(model: string | undefined, maxIter: number): ChatCompletionResponse {
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
          content: `Reached maximum tool iterations (${maxIter}) without producing a final answer. Please narrow the request or split it into smaller steps.`,
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

const CHARS_PER_TOKEN = 4
const HEAD_RATIO = 0.6

export function truncateToolOutput(content: string, maxTokens: number): string {
  const estimatedTokens = estimateTokenCount(content)
  if (estimatedTokens <= maxTokens) {
    return content
  }

  const maxChars = maxTokens * CHARS_PER_TOKEN
  const headChars = Math.floor(maxChars * HEAD_RATIO)
  const tailChars = maxChars - headChars
  const truncatedTokens = estimatedTokens - maxTokens

  const head = content.slice(0, headChars)
  const tail = content.slice(-tailChars)
  return `${head}\n\n...[truncated ~${truncatedTokens} tokens]...\n\n${tail}`
}

function estimateMessagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const msg of messages) {
    total += estimateTokenCount(msg.content)
  }
  return total
}

/**
 * Trim messages to fit within a token budget.
 * Preserves: system prompts at the start, first user message, and recent messages
 * (including all tool results from the current iteration).
 * Trims from the middle when over budget.
 */
function capContextMessages(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  const totalTokens = estimateMessagesTokens(messages)
  if (totalTokens <= maxTokens) {
    return messages
  }

  // Find boundaries: system prompts at start, first user message
  let protectedFront = 0
  while (protectedFront < messages.length && messages[protectedFront].role === 'system') {
    protectedFront++
  }
  // Include first user message if present
  if (protectedFront < messages.length && messages[protectedFront].role === 'user') {
    protectedFront++
  }

  // Protect the most recent messages (keep at least last 6 for tool call context)
  const minTailMessages = Math.min(6, messages.length - protectedFront)
  const tailStart = messages.length - minTailMessages

  if (tailStart <= protectedFront) {
    return messages // can't trim further
  }

  // Calculate tokens in protected regions
  const frontMessages = messages.slice(0, protectedFront)
  const tailMessages = messages.slice(tailStart)
  const frontTokens = estimateMessagesTokens(frontMessages)
  const tailTokens = estimateMessagesTokens(tailMessages)
  const remainingBudget = maxTokens - frontTokens - tailTokens

  if (remainingBudget <= 0) {
    // Protected regions alone exceed budget — just keep them
    return [...frontMessages, ...tailMessages]
  }

  // Fill middle from most recent to oldest (keep recent context)
  const middleMessages = messages.slice(protectedFront, tailStart)
  const keptMiddle: ChatMessage[] = []
  let middleTokens = 0

  for (let i = middleMessages.length - 1; i >= 0; i--) {
    const msgTokens = estimateTokenCount(middleMessages[i].content)
    if (middleTokens + msgTokens > remainingBudget) {
      break
    }
    keptMiddle.unshift(middleMessages[i])
    middleTokens += msgTokens
  }

  const trimmedCount = middleMessages.length - keptMiddle.length
  if (trimmedCount > 0) {
    const marker: ChatMessage = {
      role: 'system',
      content: `[${trimmedCount} earlier messages trimmed to fit context window]`,
    }
    return [...frontMessages, marker, ...keptMiddle, ...tailMessages]
  }

  return [...frontMessages, ...keptMiddle, ...tailMessages]
}

function accumulateUsage(
  acc: { prompt_tokens: number, completion_tokens: number, total_tokens: number },
  usage?: { prompt_tokens: number, completion_tokens: number, total_tokens: number }
): void {
  if (!usage) return
  acc.prompt_tokens += usage.prompt_tokens
  acc.completion_tokens += usage.completion_tokens
  acc.total_tokens += usage.total_tokens
}

export async function chatWithTools(
  client: ChatWithToolsClient,
  messages: ChatMessage[],
  options: ChatWithToolsOptions = {}
): Promise<ChatCompletionResponse> {
  const tools = options.tools ?? getToolDefinitions()
  const executeToolFn = options.executeTool ?? defaultExecuteTool
  const maxParallel = options.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS
  const maxIter = options.maxIterations ?? MAX_TOOL_ITERATIONS
  const maxToolOutput = options.maxToolOutputTokens ?? DEFAULT_MAX_TOOL_OUTPUT_TOKENS
  const maxContext = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS
  let currentMessages = [...messages]
  let iteration = 0
  let latestModel = options.model
  const totalUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  while (iteration < maxIter) {
    iteration++

    // Cap context before each LLM call to prevent overflow
    currentMessages = capContextMessages(currentMessages, maxContext)

    const response = await client.chat(currentMessages, {
      model: options.model,
      temperature: options.temperature,
      max_tokens: options.max_tokens,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    })
    latestModel = response.model
    accumulateUsage(totalUsage, response.usage)

    const choice = response.choices[0]
    if (!choice) {
      throw new Error('No response from LLM')
    }

    // If no tool calls, we're done — attach accumulated usage
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      response.usage = totalUsage
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
        const callStart = Date.now()
        const result = await executeToolFn(toolCall, options.toolContext)
        const durationMs = Date.now() - callStart
        options.onToolCall?.({ iteration, toolCall, result, durationMs })
        return { toolCall, result }
      }),
      maxParallel
    )

    // Add tool responses in original order (with output truncation)
    for (const settlement of settlements) {
      if (settlement.status === 'fulfilled') {
        const { toolCall, result } = settlement.value
        const rawContent = result.error ? `Error: ${result.error}` : result.content
        currentMessages.push({
          role: 'tool',
          content: truncateToolOutput(rawContent, maxToolOutput),
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
  const limitResponse = createIterationLimitResponse(latestModel, maxIter)
  limitResponse.usage = totalUsage
  return limitResponse
}
