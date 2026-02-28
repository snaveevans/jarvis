import type { LLMClient } from './client.ts'
import type { ChatMessage, ChatCompletionResponse } from './types.ts'
import { getToolDefinitions, executeTool as defaultExecuteTool } from '../tools/index.ts'
import { parsePositiveEnvInt } from '../tools/common.ts'
import { estimateTokenCount } from '../memory/helpers.ts'
import type { ToolCall, ToolResult, ToolExecutionContext } from '../tools/types.ts'

export class CancelledError extends Error {
  constructor(message: string = 'Operation cancelled') {
    super(message)
    this.name = 'CancelledError'
  }
}

const MAX_TOOL_ITERATIONS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_ITERATIONS', 20)
const DEFAULT_MAX_PARALLEL_TOOLS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_PARALLEL', 5)
const DEFAULT_MAX_TOOL_OUTPUT_TOKENS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_OUTPUT_TOKENS', 4000)
const DEFAULT_MAX_CONTEXT_TOKENS = parsePositiveEnvInt('JARVIS_TOOLS_MAX_CONTEXT_TOKENS', 24000)
const DEFAULT_CLARIFICATION_CHECK_INTERVAL_MS = parsePositiveEnvInt('JARVIS_CLARIFICATION_CHECK_INTERVAL_MS', 1000)

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
  /**
   * If true, automatically continue when hitting iteration limit.
   * Otherwise, returns a response asking user to continue.
   */
  autoContinue?: boolean
  signal?: AbortSignal
  /**
   * Callback to check for new user messages (clarifications) mid-processing.
   * Called periodically between iterations.
   */
  onCheckNewMessages?: () => Promise<ChatMessage[] | undefined>
}

function createProgressSummary(toolCalls: ToolCall[]): string {
  const toolNames = toolCalls.map(tc => tc.function.name)
  const uniqueTools = [...new Set(toolNames)]
  const toolCounts = uniqueTools.map(name => {
    const count = toolNames.filter(n => n === name).length
    return count > 1 ? `${name} (${count}x)` : name
  })
  return `Tools used: ${toolCounts.join(', ')}`
}

function createIterationWarning(iteration: number, maxIter: number): string | null {
  const ratio = iteration / maxIter
  if (ratio >= 0.9) {
    return `⚠️ Near tool iteration limit (${iteration}/${maxIter}). I can complete current work or you can continue by saying "continue".`
  }
  if (ratio >= 0.75) {
    return `⚠️ Approaching tool iteration limit (${iteration}/${maxIter}). Consider narrowing scope or continuing afterward.`
  }
  return null
}

function createIterationLimitResponse(
  model: string | undefined,
  maxIter: number,
  toolCalls: ToolCall[],
  accumulatedContent?: string
): ChatCompletionResponse {
  const summary = createProgressSummary(toolCalls)
  const content = accumulatedContent
    ? `${accumulatedContent}\n\n---\n\n⏹️ Tool iteration limit reached (${maxIter}).\n\n${summary}\n\nTo continue this task, re-run with "continue" or set a higher limit via JARVIS_TOOLS_MAX_ITERATIONS.`
    : `⏹️ Tool iteration limit reached (${maxIter}).\n\n${summary}\n\nTo continue this task, re-run with "continue" or set a higher limit via JARVIS_TOOLS_MAX_ITERATIONS.`

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
          content,
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
 * Sanitize messages to ensure valid conversation structure for strict LLM APIs.
 * Rules enforced:
 *  1. System messages only at the start (position 0). Any mid-conversation system
 *     messages are converted to user messages with [System Notice] prefix.
 *  2. Tool result messages must immediately follow an assistant message with tool_calls.
 *     Orphaned tool results are removed.
 *  3. The first non-system message should be 'user' (not 'assistant' or 'tool').
 *     Leading assistant/tool messages (after system) are removed.
 */
export function sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages

  const result: ChatMessage[] = []
  let pastSystemPrefix = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]

    if (msg.role === 'system') {
      if (!pastSystemPrefix) {
        result.push(msg)
        continue
      }
      // Mid-conversation system message — convert to user
      result.push({
        ...msg,
        role: 'user',
        content: `[System Notice] ${msg.content}`,
      })
      continue
    }

    pastSystemPrefix = true

    if (msg.role === 'tool') {
      // Only keep tool messages if they follow an assistant message with tool_calls
      const prev = result[result.length - 1]
      if (prev && (prev.role === 'assistant' && prev.tool_calls) || prev?.role === 'tool') {
        result.push(msg)
      }
      // Otherwise silently drop orphaned tool results
      continue
    }

    result.push(msg)
  }

  // Ensure first non-system message is 'user'
  let firstNonSystem = 0
  while (firstNonSystem < result.length && result[firstNonSystem].role === 'system') {
    firstNonSystem++
  }
  while (firstNonSystem < result.length && result[firstNonSystem].role !== 'user') {
    result.splice(firstNonSystem, 1)
  }

  return result
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
  let tailStart = messages.length - minTailMessages

  // Expand tail backwards to avoid splitting an assistant→tool group.
  // If tailStart lands on a 'tool' message, move it back to include the
  // preceding assistant message that initiated the tool calls.
  while (tailStart > protectedFront && messages[tailStart]?.role === 'tool') {
    tailStart--
  }

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

  // Ensure we don't start keptMiddle with orphaned 'tool' or 'assistant' messages.
  // The kept portion must begin on a 'user' message boundary to maintain valid
  // conversation structure (some LLM APIs reject other orderings).
  while (keptMiddle.length > 0 && keptMiddle[0].role !== 'user') {
    keptMiddle.shift()
  }

  const trimmedCount = middleMessages.length - keptMiddle.length
  if (trimmedCount > 0) {
    // Use 'user' role instead of 'system' as some LLM APIs (e.g. MiniMax) don't
    // support system messages mid-conversation.
    const marker: ChatMessage = {
      role: 'user',
      content: `[System Notice] ${trimmedCount} earlier messages trimmed to fit context window.`,
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
  const allToolCalls: ToolCall[] = []

  while (iteration < maxIter) {
    iteration++

    // Check for cancellation before proceeding
    if (options.signal?.aborted) {
      throw new CancelledError('Stopped by user')
    }

    // Cap context before each LLM call to prevent overflow
    currentMessages = capContextMessages(currentMessages, maxContext)

    // Sanitize message ordering as a safety net for strict LLM APIs
    currentMessages = sanitizeMessages(currentMessages)

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

    // Check for cancellation before executing tools
    if (options.signal?.aborted) {
      throw new CancelledError('Stopped by user')
    }

    // Execute tool calls in parallel with concurrency limit
    const toolCalls = choice.message.tool_calls.map(tc => tc as ToolCall)
    allToolCalls.push(...toolCalls)

    const settlements = await withConcurrencyLimit(
      toolCalls.map((toolCall) => async () => {
        // Check for cancellation before each tool execution
        if (options.signal?.aborted) {
          return { toolCall, result: { content: '', error: 'Stopped by user' } }
        }
        const callStart = Date.now()
        const result = await executeToolFn(toolCall, options.toolContext)
        const durationMs = Date.now() - callStart
        options.onToolCall?.({ iteration, toolCall, result, durationMs })
        return { toolCall, result }
      }),
      maxParallel
    )

    // Add tool responses in original order (with output truncation)
    // Tool results MUST immediately follow the assistant message that requested them.
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

    // Check for new user messages (clarifications) if callback provided
    if (options.onCheckNewMessages) {
      try {
        const newMessages = await options.onCheckNewMessages()
        if (newMessages && newMessages.length > 0) {
          // Add new messages to current conversation
          currentMessages.push(...newMessages)
        }
      } catch {
        // Silently ignore errors from the callback
      }
    }

    // Check for warning thresholds AFTER tool results so we don't break the
    // assistant→tool message ordering required by the API.
    const warning = createIterationWarning(iteration, maxIter)
    if (warning && !options.autoContinue) {
      currentMessages.push({
        role: 'user',
        content: `[System Notice] ${warning}`,
      })
    }
  }

  // If we hit max iterations, make one final LLM call to get a summary/context
  // before returning the limit message. This preserves context for "continue".
  // Use 'user' role instead of 'system' as some LLM APIs don't support system messages mid-conversation.
  const limitUserMessage: ChatMessage = {
    role: 'user',
    content: `⚠️ TOOL ITERATION LIMIT REACHED (${maxIter}/${maxIter}). You have executed ${allToolCalls.length} tool calls. Provide a summary of what has been accomplished so far. The user can say "continue" to proceed with more iterations.`,
  }
  const finalMessages = sanitizeMessages(capContextMessages([...currentMessages, limitUserMessage], maxContext))

  const finalResponse = await client.chat(finalMessages, {
    model: options.model,
    temperature: options.temperature,
    max_tokens: options.max_tokens,
  })
  latestModel = finalResponse.model ?? latestModel
  accumulateUsage(totalUsage, finalResponse.usage)

  // Append the limit reached notice to the response
  const summary = createProgressSummary(allToolCalls)
  const originalContent = finalResponse.choices[0]?.message?.content ?? ''
  const enhancedContent = `${originalContent}\n\n---\n\n⏹️ Tool iteration limit reached (${maxIter}).\n\n${summary}\n\nTo continue this task, simply say "continue" or set a higher limit via JARVIS_TOOLS_MAX_ITERATIONS.`

  finalResponse.choices[0].message.content = enhancedContent
  finalResponse.usage = totalUsage
  return finalResponse
}
